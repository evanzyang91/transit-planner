import { startObservation } from "@langfuse/tracing";
import { tracingEnabled } from "./tracing";
import "server-only";

import type Anthropic from "@anthropic-ai/sdk";
import {
  MAP_TOOLS,
  WRITE_TOOL_NAMES,
  runReadTool,
  resolveWriteTool,
  type ToolContext,
} from "./map-data/tools";

export type MapToolStreamChunk =
  | { type: "text"; delta: string }
  | { type: "tool_call"; name: string; args: Record<string, unknown> };

type StoredMessage = Anthropic.Messages.MessageParam;

// Read → show flows take more steps than the old freehand drawing did
// (rank_service_areas, then show_area per area), so allow a couple more loops.
const MAX_TOOL_LOOPS = 8;

// The closing reply only has to describe what was just drawn, so it gets a
// tighter budget than a full turn — this caps the cost of the extra call.
const CLOSING_MAX_TOKENS = 300;

// The main prompt carries "anything you mention you MUST draw in the SAME
// reply — if you didn't draw it, don't say it". On the closing call there are
// no tools to draw with, so that rule would gag the model and reproduce the
// very silence this call exists to fix. Lift it for this one call: the drawing
// already happened, and describing it is the entire job.
const CLOSING_DIRECTIVE = `The map actions above have ALREADY been drawn successfully and the user can see them.

You have no tools for this reply — do not attempt to draw anything else. The "only say what you drew" rule is already satisfied, because everything referenced above was drawn.

In 1-3 short sentences, tell the user what you just put on the map and what it shows. Answer the question they actually asked.`;

const ANTHROPIC_MAP_TOOLS: Anthropic.Messages.Tool[] = MAP_TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.inputSchema as Anthropic.Messages.Tool["input_schema"],
}));

/**
 * Stream a map-assistant reply with Anthropic tool use.
 *
 * READ tools run server-side against the live network + census raster and feed
 * data back to the model. WRITE tools are *resolved* server-side
 * (resolveWriteTool): geometry is validated/looked up, then either forwarded
 * to the client as a tool_call event, or rejected — and the rejection reason
 * goes back to the model as its tool_result so it can self-correct instead of
 * believing it drew something.
 */
export async function* streamMapToolResponse(
  client: Anthropic,
  params: {
    system: string;
    history: StoredMessage[];
    userMessage: string;
    model: string;
    maxTokens: number;
    /** Per-request grounding context: live network + artifact store. */
    ctx: ToolContext;
  },
): AsyncGenerator<MapToolStreamChunk, { assistantText: string; history: StoredMessage[] }> {
  let messages: StoredMessage[] = [
    ...params.history,
    { role: "user", content: params.userMessage },
  ];
  let assistantText = "";

  // Langfuse trace root for one map-assistant turn. "agent" rather than a plain
  // span: this is an autonomous tool-using loop, and that observation type is
  // what drives Langfuse's Agent Graph. Children hang off this handle instead
  // of OTel ambient context, which an async generator cannot keep current
  // across its yields.
  const turn = tracingEnabled
    ? startObservation("map-assistant", { input: params.userMessage }, { asType: "agent" })
    : null;

  try {
  for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
    const generation = turn?.startObservation(
      `llm-call-${loop + 1}`,
      {
        model: params.model,
        input: messages,
        modelParameters: { max_tokens: params.maxTokens },
      },
      { asType: "generation" },
    );

    const stream = client.messages.stream({
      model: params.model,
      max_tokens: params.maxTokens,
      system: params.system,
      messages,
      tools: ANTHROPIC_MAP_TOOLS,
      tool_choice: { type: "auto" },
    });

    // Stream text deltas straight through; tool args are handled after the
    // message completes (write resolution is async — land checks, road snap).
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        assistantText += event.delta.text;
        yield { type: "text", delta: event.delta.text };
      }
    }

    const final = await stream.finalMessage();

    // usageDetails is what lets Langfuse compute cost for this call.
    generation?.update({
      output: final.content,
      usageDetails: {
        input: final.usage.input_tokens,
        output: final.usage.output_tokens,
      },
    }).end();

    const toolUses = final.content.filter(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
    );

    if (toolUses.length === 0) {
      messages = [...messages, { role: "assistant", content: final.content }];
      return { assistantText, history: messages };
    }

    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
    let anyRejected = false;
    let anyRead = false;

    for (const tu of toolUses) {
      const args = tu.input as Record<string, unknown>;

      // One observation per tool call — this IS the "thought process": which
      // tool ran, its arguments, and what came back. kind=write/read is carried
      // as metadata so a trace can be filtered to just the map mutations.
      const toolSpan = turn?.startObservation(
        tu.name,
        { input: args, metadata: { kind: WRITE_TOOL_NAMES.has(tu.name) ? "write" : "read" } },
        { asType: "tool" },
      );

      if (WRITE_TOOL_NAMES.has(tu.name)) {
        const resolution = await resolveWriteTool(tu.name, args, params.ctx);
        if (resolution.status === "rendered") {
          // The client receives the SERVER-resolved args (real polygons,
          // snapped paths) — never the model's raw geometry.
          yield { type: "tool_call", name: resolution.clientName, args: resolution.clientArgs };
          // Log the SERVER-resolved args, not the model's raw geometry — that
          // is what actually reached the map.
          toolSpan?.update({
            output: { status: "rendered_on_map", resolvedArgs: resolution.clientArgs },
          }).end();
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: JSON.stringify({ status: "rendered_on_map" }),
          });
        } else {
          anyRejected = true;
          // A rejected write is the single most useful thing in these traces:
          // it is the model proposing something the server refused.
          toolSpan?.update({ output: { error: resolution.error }, level: "WARNING" }).end();
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: JSON.stringify({ error: resolution.error }),
            is_error: true,
          });
        }
      } else {
        anyRead = true;
        let resultJson: string;
        try {
          const result = await runReadTool(tu.name, args, params.ctx);
          resultJson = JSON.stringify(result);
          toolSpan?.update({ output: result }).end();
        } catch (e) {
          resultJson = JSON.stringify({ error: String(e) });
          toolSpan?.update({ output: { error: String(e) }, level: "ERROR" }).end();
        }
        toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: resultJson });
      }
    }

    messages = [
      ...messages,
      { role: "assistant", content: final.content },
      { role: "user", content: toolResults },
    ];

    // Pure-write turn where everything rendered. This used to return straight
    // away, which cut the reply off mid-thought: the model would say "let me
    // circle Rosedale:", draw the circle, and never get to say what it drew.
    //
    // So make ONE closing call instead. tool_choice "none" is what makes that
    // safe — the model sees the tool results and can only answer in words, so
    // it physically cannot start another drawing spree, which is the failure
    // the old early return was guarding against. The tools stay declared
    // because the history contains tool_use blocks and the API validates them
    // against the declared set; dropping `tools` here would 400.
    // 📖 Learn: Anthropic tool_choice — "auto" lets the model decide whether to
    // call a tool, "none" forbids calling while keeping the definitions in scope.
    if (!anyRead && !anyRejected) {
      const closing = turn?.startObservation(
        "closing-summary",
        {
          model: params.model,
          input: messages,
          modelParameters: { max_tokens: CLOSING_MAX_TOKENS },
        },
        { asType: "generation" },
      );

      const closingStream = client.messages.stream({
        model: params.model,
        max_tokens: CLOSING_MAX_TOKENS,
        system: `${params.system}\n\n${CLOSING_DIRECTIVE}`,
        messages,
        tools: ANTHROPIC_MAP_TOOLS,
        tool_choice: { type: "none" },
      });

      for await (const event of closingStream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          assistantText += event.delta.text;
          yield { type: "text", delta: event.delta.text };
        }
      }

      const closingFinal = await closingStream.finalMessage();
      closing?.update({
        output: closingFinal.content,
        usageDetails: {
          input: closingFinal.usage.input_tokens,
          output: closingFinal.usage.output_tokens,
        },
      }).end();

      messages = [...messages, { role: "assistant", content: closingFinal.content }];
      return { assistantText, history: messages };
    }
  }

  return { assistantText, history: messages };
  } finally {
    // finally, not a tail call. Every `return` above exits mid-loop, and a
    // generator abandoned by its consumer (client disconnects mid-stream)
    // resumes here via .return(). An unended span is never exported at all.
    turn?.update({ output: assistantText }).end();
  }
}
