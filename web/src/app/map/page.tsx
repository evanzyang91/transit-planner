import { type Metadata } from "next";
import { TransitMap } from "~/app/_components/TransitMap";
import { AIAnnotationsProvider } from "~/app/_components/map/AIAnnotationsContext";
import { MapAssistantProvider } from "~/app/_components/map/MapAssistantContext";

export const metadata: Metadata = {
  title: "Map Editor",
  description: "Interactive transit map editor — draw routes, drop stops, and run AI council analysis.",
  robots: { index: false, follow: false },
};

export default function MapPage() {
  return (
    <main className="h-screen w-screen overflow-hidden">
      {/* Order matters: the assistant draws through the annotations context,
          and TransitMap registers its bridge with the assistant, so each
          provider wraps everything that uses it. */}
      <AIAnnotationsProvider>
        <MapAssistantProvider>
          <TransitMap />
        </MapAssistantProvider>
      </AIAnnotationsProvider>
    </main>
  );
}
