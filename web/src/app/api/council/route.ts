import { type NextRequest } from "next/server";
import { type ExistingStop } from "~/server/council";
import { runCouncilGraph } from "~/server/council-graph";
import { trackCouncilRequest } from "~/server/discord";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface CouncilRequestBody {
  neighbourhoods?: string[];
  stations?: string[];
  line_type?: string | null;
  context?: string | null;
  existing_lines?: ExistingStop[];
  provider?: string;
  randomize_speaking_order?: boolean;
}

export async function POST(req: NextRequest) {
  const body = await req.json() as CouncilRequestBody;

  void trackCouncilRequest(req.headers.get("host"), {
    neighbourhoods: body.neighbourhoods ?? [],
    lineType: body.line_type,
    stationCount: body.stations?.length ?? 0,
  });

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      try {
        for await (const chunk of runCouncilGraph({
          neighbourhoods: body.neighbourhoods ?? [],
          stations: body.stations ?? [],
          lineType: body.line_type,
          extraContext: body.context,
          existingLines: body.existing_lines ?? [],
          provider: body.provider,
          randomizeSpeakingOrder: body.randomize_speaking_order ?? true,
        })) {
          controller.enqueue(encoder.encode(chunk));
        }
      } catch (err) {
        const errChunk = `data: ${JSON.stringify({ type: "status", text: `Fatal error: ${String(err)}` })}\n\n`;
        controller.enqueue(encoder.encode(errChunk));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}
