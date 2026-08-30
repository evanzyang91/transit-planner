import { NextRequest } from "next/server";
import { getProvider, DEFAULT_SYSTEM_PROMPT } from "~/server/ai-provider";
import { trackChatMessage } from "~/server/discord";
import { buildNetwork } from "~/server/map-data/network";
import { populationServedByNetwork } from "~/server/map-data/census";
import { buildMapAssistantSystemPrompt } from "~/server/map-data/prompt";
import { ArtifactStore, type ToolContext } from "~/server/map-data/tools";
import { flushTracing } from "~/server/tracing";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      message: string;
      assistantId?: string;
      threadId?: string;
      systemPrompt?: string;
      model?: string;
      maxTokens?: number;
      provider?: string;
      /** When true, use grounded map tools (assistant surface). */
      mapTools?: boolean;
      /**
       * The client's LIVE route state (user-drawn lines included) — the network
       * every map tool queries this request. Same pattern as /api/council's
       * existingLines. Ignored unless mapTools is set.
       */
      networkRoutes?: unknown;
    };

    const {
      message,
      assistantId: providedAssistantId,
      threadId: providedThreadId,
      model = "claude-haiku-4-5-20251001",
      maxTokens = 600,
      provider,
      mapTools = false,
      networkRoutes,
    } = body;

    void trackChatMessage({ message, model });

    if (!message) {
      return new Response(JSON.stringify({ error: "message is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const aiProvider = getProvider(provider);

    // Map-assistant grounding. The system prompt is server-built per request:
    // clients may NOT inject a prompt on this surface (that used to be both a
    // drift bug — two prompt copies — and an injection vector).
    let mapCtx: ToolContext | null = null;
    if (mapTools) {
      const network = buildNetwork(networkRoutes);
      const coverage = await populationServedByNetwork(network);
      mapCtx = {
        network,
        artifacts: new ArtifactStore(),
        systemPrompt: buildMapAssistantSystemPrompt(
          network,
          coverage
            ? {
                pctPopulationServed: coverage.pct,
                servedPopulation: coverage.servedPopulation,
                totalPopulation: coverage.totalPopulation,
              }
            : null,
        ),
      };
    }

    const systemPrompt = mapCtx?.systemPrompt ?? body.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;

    let assistantId = providedAssistantId;
    assistantId ??= await aiProvider.createAssistant("Transit Planner", systemPrompt);

    let threadId = providedThreadId;
    threadId ??= await aiProvider.createThread(assistantId);

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "metadata", assistantId, threadId })}\n\n`,
            ),
          );

          const ai = aiProvider;

          if (mapCtx && ai.streamMessageWithMapTools) {
            for await (const chunk of ai.streamMessageWithMapTools(
              threadId,
              message,
              mapCtx,
              model,
              maxTokens,
            )) {
              if (chunk.type === "text") {
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ type: "text", delta: chunk.delta })}\n\n`,
                  ),
                );
              } else if (chunk.type === "tool_call") {
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({
                      type: "tool_call",
                      name: chunk.name,
                      args: chunk.args,
                    })}\n\n`,
                  ),
                );
              }
            }
          } else {
            for await (const chunk of ai.streamMessage(
              threadId,
              message,
              model,
              maxTokens,
            )) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "content", text: chunk })}\n\n`,
                ),
              );
            }
          }

          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          // Ship spans BEFORE closing. A serverless function is frozen the
          // moment its response completes, which kills the background exporter
          // mid-flight — traces would silently never arrive.
          await flushTracing();
          controller.close();
        } catch (error) {
          console.error("Streaming error:", error);
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: "error",
                error: error instanceof Error ? error.message : "Unknown error",
              })}\n\n`,
            ),
          );
          // Flush on the failure path too — a trace of a failed turn is the
          // one you most want to look at.
          await flushTracing();
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    console.error("AI chat API error:", error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Failed to process request",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}
