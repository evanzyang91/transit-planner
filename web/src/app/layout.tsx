import "~/styles/globals.css";

import { type Metadata } from "next";
import { Auth0Provider } from "@auth0/nextjs-auth0/client";
import MobileWarningModal from "./_components/MobileWarningModal";
import VercelRedirectModal from "./_components/VercelRedirectModal";
import MixpanelInit from "./_components/MixpanelInit";
import PageViewTracker from "./_components/PageViewTracker";
import PreviewBuildBadge from "./_components/PreviewBuildBadge";
import TrackingIntegrations from "./_components/TrackingIntegrations";

const BASE_URL =
  process.env.NEXT_PUBLIC_BASE_URL ??
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");

export const metadata: Metadata = {
  metadataBase: new URL(BASE_URL),
  title: {
    default: "Transit Planner",
    template: "%s | Transit Planner",
  },
  description:
    "AI-powered urban transit design tool. Draw subway, streetcar, and bus routes on an interactive map of Toronto, then watch an AI council of six agents debate ridership, cost, and community impact in real time.",
  keywords: [
    "transit planning",
    "urban planning",
    "subway map",
    "Toronto transit",
    "GTFS",
    "AI planning",
    "public transit",
    "city planning",
    "TTC",
    "transit design",
  ],
  authors: [{ name: "Transit Planner" }],
  creator: "Transit Planner",
  publisher: "Transit Planner",
  manifest: "/site.webmanifest",
  openGraph: {
    type: "website",
    locale: "en_CA",
    url: BASE_URL,
    siteName: "Transit Planner",
    title: "Transit Planner — AI-Powered Urban Transit Design",
    description:
      "Draw subway, LRT, and bus routes on a live map of Toronto. An AI council debates every proposal — ridership, cost, and neighbourhood impact included.",
    images: [
      {
        url: "/opengraph-image",
        width: 1200,
        height: 630,
        alt: "Transit Planner — AI-Powered Urban Transit Design",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Transit Planner — AI-Powered Urban Transit Design",
    description:
      "Draw subway, LRT, and bus routes on a live map of Toronto. An AI council debates every proposal in real time.",
    images: ["/opengraph-image"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  icons: [{ rel: "icon", url: "/favicon.ico" }],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: `(function(){try{var p=new URLSearchParams(window.location.search);if(p.has("m")){localStorage.setItem("skip_tracking","1");p.delete("m");var q=p.toString();window.history.replaceState({},"",window.location.pathname+(q?"?"+q:"")+window.location.hash)}var s=localStorage.getItem("darkMode");var d=(s===null)?window.matchMedia("(prefers-color-scheme: dark)").matches:s==="1";if(d)document.documentElement.classList.add("dark");if(localStorage.getItem("highContrast")==="1")document.documentElement.classList.add("hc");}catch(e){}})();` }} />
        {/* mapbox-gl.css is copied to public/ by the prebuild script.
            We load it here instead of via webpack import because npm workspaces
            hoists mapbox-gl to the monorepo root, and Next.js's CSS pipeline
            can't process CSS files from parent directories. */}
        <link rel="stylesheet" href="/mapbox-gl.css" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Google+Sans:wght@400;500;700&family=Google+Sans+Display:wght@400;500;700&family=Nunito:wght@400;600;700;800;900&display=swap" rel="stylesheet" />
      </head>
      {/* suppressHydrationWarning: browser extensions (Grammarly, ColorZilla,
          password managers…) add attributes to <body> before React hydrates,
          which React would report as a server/client mismatch. Like the one
          on <html> above, it only silences attribute differences on this one
          element, not on anything inside it.
          📖 Learn: suppressHydrationWarning — https://react.dev/reference/react-dom/client/hydrateRoot#suppressing-unavoidable-hydration-mismatch-errors */}
      <body suppressHydrationWarning>
        <Auth0Provider>
          <MixpanelInit />
          <PageViewTracker />
          <MobileWarningModal />
          <VercelRedirectModal />
          <PreviewBuildBadge />
          {children}
        </Auth0Provider>
        <TrackingIntegrations />
      </body>
    </html>
  );
}
