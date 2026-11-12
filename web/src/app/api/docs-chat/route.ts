// 📖 Learn: Next.js App Router API routes — a file named route.ts in app/api/...
// automatically becomes a server-side HTTP endpoint. The exported POST function
// handles POST requests to /api/docs-chat.

import { getProvider } from "~/server/ai-provider";
import type { ChatMessage } from "~/server/ai-provider";
// The same knowledge pack the Ask AI map assistant uses (core + every
// methodology topic), so the two assistants can't contradict each other.
import { buildDocsCorpus } from "~/lib/project-knowledge";

export type { ChatMessage };

export async function POST(req: Request) {
  const { question, history = [], provider } = (await req.json()) as {
    question: string;
    history: ChatMessage[];
    provider?: string;
  };

  if (!question?.trim()) {
    return Response.json({ error: "question is required" }, { status: 400 });
  }

  // 📖 Learn: RAG — Augmentation step.
  // We inject the full docs corpus into the system prompt. The AI will answer
  // ONLY from this context, which prevents hallucination about our specific app.
  // (The corpus is small enough — ~7k tokens — to include whole; no retrieval needed.)
  const systemPrompt = `You are a helpful assistant for the Transit Planner documentation.
Answer questions based ONLY on the documentation provided below.
Be concise and direct. Use markdown formatting where helpful (bold, bullet lists).
If something is not covered in the docs, say so clearly rather than guessing.
You cannot see the user's map. Where the docs list a known issue, describe the app as it behaves today.

${buildDocsCorpus()}`;

  // 📖 Learn: Streaming with SSE (Server-Sent Events).
  // Instead of waiting for the full response, we send chunks as they arrive.
  // The client reads these using the EventSource API (or fetch with a ReadableStream reader).
  // This makes the UI feel fast — words appear as the model generates them.
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        // 📖 Learn: streamDirect() takes a system prompt + full message history
        // (including the new question at the end) and streams back text chunks.
        // We pass the full history so the model can answer follow-up questions.
        const messages: ChatMessage[] = [
          ...history,
          { role: "user", content: question },
        ];

        for await (const text of getProvider(provider).streamDirect(
          systemPrompt,
          messages,
          "claude-haiku-4-5-20251001",
          1024,
        )) {
          const payload = JSON.stringify({ text });
          controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
        }

        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ error: msg })}\n\n`),
        );
      } finally {
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
}
