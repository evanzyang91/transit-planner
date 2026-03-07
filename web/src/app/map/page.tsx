import "mapbox-gl/dist/mapbox-gl.css";
import { TransitMap } from "~/app/_components/TransitMap";

export default function MapPage() {
  return (
    <main className="h-screen w-screen overflow-hidden">
      <TransitMap />
    </main>
  );
}
