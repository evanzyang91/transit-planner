import { type NextRequest, NextResponse } from "next/server";
import { getProvider, DEFAULT_SYSTEM_PROMPT } from "~/server/ai-provider";

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
    };

    const {
      message,
      assistantId: providedAssistantId,
      threadId: providedThreadId,
      systemPrompt = DEFAULT_SYSTEM_PROMPT,
      model = "claude-haiku-4-5-20251001",
      maxTokens = 600,
      provider,
    } = body;

    if (!message) {
      return NextResponse.json(
        { error: "message is required" },
        { status: 400 },
      );
    }

    let assistantId = providedAssistantId;
    if (!assistantId) {
      assistantId = await getProvider(provider).createAssistant("Transit Planner", systemPrompt);
    }

    let threadId = providedThreadId;
    if (!threadId) {
      threadId = await getProvider(provider).createThread(assistantId);
    }

    const response = await getProvider(provider).sendMessage(threadId, message, model, maxTokens);

    return NextResponse.json({
      response,
      assistantId,
      threadId,
    });
  } catch (error) {
    console.error("Anthropic API error:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to process request",
      },
      { status: 500 },
    );
  }
}
