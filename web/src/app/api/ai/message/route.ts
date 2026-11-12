import { type NextRequest, NextResponse } from "next/server";
import { getProvider, DEFAULT_SYSTEM_PROMPT } from "~/server/ai-provider";

export const dynamic = "force-dynamic";

/**
 * One-shot, stateless completion: system prompt + one message in, text out.
 * Only caller: TransitMap's generated-route stats (it sends no ids).
 *
 * This used to create an assistant AND a thread in server memory on every
 * call and never delete them — a slow leak. A single question needs no
 * session, so it now goes through streamDirect and collects the text.
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      message?: unknown;
      systemPrompt?: unknown;
      model?: unknown;
      maxTokens?: unknown;
      provider?: unknown;
    };

    const message = typeof body.message === "string" ? body.message : "";
    if (!message.trim()) {
      return NextResponse.json({ error: "message is required" }, { status: 400 });
    }
    const systemPrompt =
      typeof body.systemPrompt === "string" && body.systemPrompt.trim() ? body.systemPrompt : DEFAULT_SYSTEM_PROMPT;
    const model = typeof body.model === "string" && body.model ? body.model : "claude-haiku-4-5-20251001";
    // Clamp so a client can't ask for a huge (and expensive) reply.
    const maxTokens =
      typeof body.maxTokens === "number" && Number.isFinite(body.maxTokens)
        ? Math.min(4096, Math.max(1, Math.round(body.maxTokens)))
        : 600;
    const provider = typeof body.provider === "string" ? body.provider : undefined;

    let response = "";
    for await (const chunk of getProvider(provider).streamDirect(
      systemPrompt,
      [{ role: "user", content: message }],
      model,
      maxTokens,
    )) {
      response += chunk;
    }

    // Same shape as before, minus the assistantId/threadId (there is no session any more).
    return NextResponse.json({ response });
  } catch (error) {
    console.error("AI message API error:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to process request",
      },
      { status: 500 },
    );
  }
}
