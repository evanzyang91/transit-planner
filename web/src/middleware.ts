import type { NextFetchEvent, NextRequest } from "next/server";
import { auth0 } from "~/lib/auth0";
import { reportAiFetch } from "~/server/ai-fetch-reporter";

export async function middleware(request: NextRequest, event: NextFetchEvent) {
  // waitUntil lets the Discord post finish AFTER the response is sent, so the
  // request (bot or human) never waits on Discord.
  // 📖 Learn: waitUntil in middleware — https://nextjs.org/docs/app/api-reference/file-conventions/middleware#waituntil-and-nextfetchevent
  const aiFetchReport = reportAiFetch(request);
  if (aiFetchReport) event.waitUntil(aiFetchReport);

  return await auth0.middleware(request);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)",
  ],
};
