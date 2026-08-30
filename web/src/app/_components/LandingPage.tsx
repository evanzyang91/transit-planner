"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, Suspense, useMemo } from "react";
import { Canvas, useFrame, useLoader } from "@react-three/fiber";
import * as THREE from "three";



// ── Great-circle transit line ─────────────────────────────────────────────────
// Rendered in LOCAL globe space so it rotates with the globe (sits on surface).
function GreatCircleOrbit({ color, normal, speed, phases, r = 6.01 }: {
  color: string;
  normal: [number, number, number];
  speed: number;
  phases: number[];
  r?: number;
}) {
  const R = r;

  // Two orthonormal basis vectors spanning the orbit plane

  const { u, v } = useMemo(() => {
    const n = new THREE.Vector3(...normal).normalize();
    const arb = Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const uu = new THREE.Vector3().crossVectors(n, arb).normalize();
    const vv = new THREE.Vector3().crossVectors(n, uu).normalize();
    return { u: uu, v: vv };
  }, []);

  const trainRefs = useRef<(THREE.Group | null)[]>(phases.map(() => null));
  const angles = useRef([...phases]);

  const getPos = (a: number): [number, number, number] => [
    R * (Math.cos(a) * u.x + Math.sin(a) * v.x),
    R * (Math.cos(a) * u.y + Math.sin(a) * v.y),
    R * (Math.cos(a) * u.z + Math.sin(a) * v.z),
  ];

  const getTangent = (a: number) => new THREE.Vector3(
    -Math.sin(a) * u.x + Math.cos(a) * v.x,
    -Math.sin(a) * u.y + Math.cos(a) * v.y,
    -Math.sin(a) * u.z + Math.cos(a) * v.z,
  ).normalize();



  const circleObject = useMemo(() => {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 128; i++) {
      const [x, y, z] = getPos((i / 128) * Math.PI * 2);
      pts.push(new THREE.Vector3(x, y, z));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.18 });
    return new THREE.Line(geo, mat);
  }, []);

  useFrame((_, delta) => {
    for (let i = 0; i < angles.current.length; i++) {
      angles.current[i] = (angles.current[i] ?? 0) + delta * speed;
      const a = angles.current[i]!;
      const [x, y, z] = getPos(a);

      const ref = trainRefs.current[i];
      if (ref) {
        ref.position.set(x, y, z);
        const tangent = getTangent(a);
        const outward = new THREE.Vector3(x, y, z).normalize();
        const binormal = new THREE.Vector3().crossVectors(tangent, outward).normalize();
        ref.setRotationFromMatrix(new THREE.Matrix4().makeBasis(tangent, outward, binormal));
      }

    }
  });

  // Curved train: 8 segments each positioned + rotated along the great-circle arc.
  // In local group space (X=tangent, Y=outward, Z=binormal):
  //   arc point at angle δ → (R·sin δ, R·(cos δ − 1), 0)
  //   rotated by −δ around Z so the segment body is tangent to the sphere.

  const segData = useMemo(() => {
    const HALF_ARC = 0.24; // radians each side (arc length ≈ 2.9 world units)
    const N = 8;
    const segLen = (HALF_ARC * 2 * R / N) + 0.015;
    return Array.from({ length: N }, (_, si) => {
      const delta = -HALF_ARC + (si + 0.5) / N * HALF_ARC * 2;
      return { x: R * Math.sin(delta), y: R * (Math.cos(delta) - 1), rotZ: -delta, len: segLen };
    });
  }, []);

  return (
    <>
      <primitive object={circleObject} />

      {phases.map((_, i) => (
        <group key={i} ref={(el) => { trainRefs.current[i] = el; }}>
          {segData.map(({ x, y, rotZ, len }, si) => (
            <group key={si} position={[x, y, 0]} rotation={[0, 0, rotZ]}>
              {/* Body */}
              <mesh position={[0, 0.095, 0]}>
                <boxGeometry args={[len, 0.19, 0.17]} />
                <meshStandardMaterial color={color} roughness={0.35} metalness={0.3} />
              </mesh>
              {/* Roof */}
              <mesh position={[0, 0.195, 0]}>
                <boxGeometry args={[len, 0.022, 0.145]} />
                <meshStandardMaterial color={color} roughness={0.5} metalness={0.2} />
              </mesh>
              {/* Windows — front */}
              <mesh position={[0, 0.115, 0.087]}>
                <boxGeometry args={[len * 0.85, 0.058, 0.001]} />
                <meshStandardMaterial color="#d0ecff" transparent opacity={0.85} roughness={0.05} metalness={0.6} />
              </mesh>
              {/* Windows — back */}
              <mesh position={[0, 0.115, -0.087]}>
                <boxGeometry args={[len * 0.85, 0.058, 0.001]} />
                <meshStandardMaterial color="#d0ecff" transparent opacity={0.85} roughness={0.05} metalness={0.6} />
              </mesh>
            </group>
          ))}
        </group>
      ))}
    </>
  );
}

// ── Spinning globe ────────────────────────────────────────────────────────────
function Globe({ isDark }: { isDark: boolean }) {
  const groupRef = useRef<THREE.Group>(null);
  const R = 6;

  const overlayTexture = useLoader(THREE.TextureLoader, "/homepageoverlay.jpg");
  overlayTexture.wrapS = THREE.RepeatWrapping;
  overlayTexture.wrapT = THREE.RepeatWrapping;
  overlayTexture.repeat.set(2, 1);

  useFrame(({ clock }) => {
    if (groupRef.current) {
      groupRef.current.rotation.y = clock.getElapsedTime() * 0.055;
    }
  });

  // meshBasicMaterial multiplies `color` with the texture, so dark gray dims the globe
  const globeColor = isDark ? "#383838" : "#ffffff";

  return (
    <group ref={groupRef} position={[0, -7.0, 0]}>
      <mesh>
        <sphereGeometry args={[R, 96, 96]} />
        <meshBasicMaterial map={overlayTexture} color={globeColor} />
      </mesh>
      {/* Transit lines are children of the globe → rotate with it → sit on surface */}
      <GreatCircleOrbit color="#d03527" normal={[0, 0, 1]}         speed={0.38} phases={[0, Math.PI * 2 / 3, Math.PI * 4 / 3]}                          r={6.01} />
      <GreatCircleOrbit color="#facc15" normal={[1, 0.3, 0]}       speed={0.55} phases={[Math.PI / 4, Math.PI, Math.PI * 7 / 4]}                         r={6.01} />
      <GreatCircleOrbit color="#3b82f6" normal={[0.4, 1, 0.6]}     speed={0.47} phases={[0, Math.PI * 2 / 3, Math.PI * 4 / 3]}                           r={6.01} />
      <GreatCircleOrbit color="#a3e635" normal={[-0.6, 0.2, 0.8]}  speed={0.63} phases={[Math.PI / 2, Math.PI * 3 / 2]}                                  r={6.01} />
      <GreatCircleOrbit color="#38bdf8" normal={[0.3, 0.8, -0.5]}  speed={0.42} phases={[Math.PI * 0.15, Math.PI * 0.82, Math.PI * 1.5]}                  r={6.01} />
    </group>
  );
}

// ── 3D scene ──────────────────────────────────────────────────────────────────
function Scene({ isDark }: { isDark: boolean }) {
  return (
    <>
      <ambientLight intensity={0.2} />
      <directionalLight position={[8, 4, 5]} intensity={3.5} color="#ffffff" />
      <directionalLight position={[-6, -2, -4]} intensity={0.1} color="#d0d8e8" />
      <Globe isDark={isDark} />
    </>
  );
}

// ── Landing page ──────────────────────────────────────────────────────────────
export default function LandingPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [visible, setVisible] = useState(false);
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    // Read initial dark mode state from the html class (set by layout.tsx inline script)
    setIsDark(document.documentElement.classList.contains("dark"));
    // Watch for dark mode toggled at runtime
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains("dark"));
    });
    observer.observe(document.documentElement, { attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setReady(true);
    const t = setTimeout(() => setVisible(true), 60);
    // Prefetch map page JS bundle + heavy data assets
    router.prefetch("/map");
    void Promise.allSettled([
      fetch("/Neighbourhoods - 4326.geojson"),
      fetch("/api/population"),
      fetch("/api/traffic"),
    ]);
    return () => clearTimeout(t);
  }, [router]);

  const fadeUp = (delay: string) => ({
    opacity: visible ? 1 : 0,
    transform: visible ? "translateY(0)" : "translateY(18px)",
    transition: `opacity 1s ease ${delay}, transform 1s ease ${delay}`,
  });

  return (
    <main className={`overflow-x-hidden font-sans ${isDark ? 'bg-gray-900' : 'bg-white'}`}>

      {/* ── Globe hero — clipped with rounded bottom corners ─────────────── */}
      {/* overflow:hidden + border-radius clips the canvas and overlay inside this box */}
      <div
        className="relative"
        style={{
          minHeight: "100vh",
          overflow: "hidden",
          borderRadius: "0 0 48px 48px",
          backgroundColor: isDark ? "#1f2937" : "#ffffff",
          boxShadow: isDark ? "0 8px 48px rgba(0,0,0,0.30)" : "0 8px 48px rgba(0,0,0,0.10)",
        }}
      >

        {/* Background overlay image */}
        <div
          className="absolute inset-0 z-0"
          style={{
            backgroundImage: "url('/homepageoverlay.jpg')",
            backgroundSize: "cover",
            backgroundPosition: "center",
            opacity: isDark ? 0.15 : 0.3,
          }}
        />

        {/* 3D globe canvas */}
        {ready && (
          <div className="absolute inset-0 z-0">
            <Canvas
              camera={{ position: [0, 0, 7], fov: 45 }}
              gl={{ antialias: true, alpha: true }}
              style={{ background: "transparent" }}
            >
              <Suspense fallback={null}>
                <Scene isDark={isDark} />
              </Suspense>
            </Canvas>
          </div>
        )}

        {/* UI layer */}
        <div className="relative z-10 flex min-h-screen flex-col">

        {/* Hero */}
        <div className="flex flex-1 flex-col items-center justify-center px-6 pb-64">

          {/* SVG filter for rounding text terminals */}
          <svg style={{ position: "absolute", width: 0, height: 0 }}>
            <defs>
              <filter id="round-text" x="-5%" y="-5%" width="110%" height="110%">
                <feMorphology operator="dilate" radius="8" result="expanded" />
                <feGaussianBlur stdDeviation="6" result="blurred" />
                <feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 60 -20" result="threshold" />
                <feComposite in="SourceGraphic" in2="threshold" operator="in" />
              </filter>
            </defs>
          </svg>

          {/* Title */}
          <h1
            className="mb-3 select-none text-center leading-none text-stone-800 dark:text-stone-100"
            style={{
              fontFamily: '"Google Sans Display", "Google Sans", sans-serif',
              fontWeight: 700,
              fontSize: "clamp(3.5rem, 10vw, 8rem)",
              letterSpacing: "-0.04em",
              lineHeight: "0.9",
              filter: "url(#round-text)",
              ...fadeUp("0.2s"),
            }}
          >
            Transit Planner
          </h1>
          <p
            className="mb-6 select-none text-center font-normal text-stone-500 dark:text-stone-200"
            style={{ fontSize: "clamp(1.7rem, 4vw, 2.6rem)", ...fadeUp("0.28s") }}
          >
            Plan at scale. Visualize city data in seconds.
          </p>

          {/* CTA button — matches map's "Generate Route" style */}
          <Link
            href="/map"
            className="mt-6 flex h-[72px] items-center gap-3 rounded-xl border border-stone-900 bg-stone-900 px-7 text-xl font-normal text-white shadow-sm transition-all hover:bg-stone-800"
            style={{ ...fadeUp("0.35s"), opacity: 0.9, backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)" }}
          >
            Start Mapping
            <span style={{color: "white", fontWeight: 700}}>→</span>
          </Link>

          <div className="mt-4 flex items-center gap-4" style={{ ...fadeUp("0.45s") }}>
            <Link
              href="/about"
              className="text-xs text-stone-400 underline-offset-2 transition-colors hover:text-stone-600 hover:underline"
            >
              Read more
            </Link>
            <span className="text-stone-300" aria-hidden="true">·</span>
            <a
              href="https://github.com/evanzyang91/transit-planner"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-xs text-stone-400 underline-offset-2 transition-colors hover:text-stone-600 hover:underline"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844a9.59 9.59 0 012.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.942.359.31.678.921.678 1.856 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"/></svg>
              GitHub
            </a>
          </div>
        </div>
        </div>{/* end UI layer */}
      </div>{/* end globe wrapper */}

      {/* ════════════════════════════════════════════════════════════════════
          Feature sections — cream background, same palette as docs
          ════════════════════════════════════════════════════════════════════ */}
      <div style={{ backgroundColor: isDark ? "#111827" : "#f8f7f4" }}>

        {/* ── 1. AI Council — split layout (mockup left, text right) ───────── */}
        <section style={{ maxWidth: 1280, margin: "0 auto", padding: "120px clamp(20px, 5vw, 64px)", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(400px, 100%), 1fr))", gap: 80, alignItems: "center" }}>

          {/* Dark mockup card — simulated council chat */}
          <div style={{ backgroundColor: "#111827", borderRadius: 28, padding: "28px 28px 20px", overflow: "hidden", border: isDark ? "1px solid rgba(255,255,255,0.10)" : "1px solid transparent" }}>
            {/* Window chrome dots */}
            <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 20 }}>
              {["#ef4444","#f59e0b","#22c55e"].map(c => <div key={c} style={{ width: 10, height: 10, borderRadius: "50%", backgroundColor: c }} />)}
              <span style={{ fontSize: 11.5, color: "rgba(255,255,255,0.3)", marginLeft: 10, fontFamily: "monospace" }}>Council Session</span>
            </div>

            {/* Agent messages */}
            {[
              { name: "Alex Chen", role: "Ridership Planner", color: "#2563eb", text: "Eglinton East needs a direct link — 340k daily commuters are underserved by the current network." },
              { name: "Jordan Park", role: "Cost Analyst", color: "#16a34a", text: "Cut Brimley and Morningside. Insufficient ROI vs. tunnel cost. Route length adds $2.1B." },
              { name: "Margaret Thompson", role: "Neighbourhood Rep", color: "#dc2626", text: "Construction at Kingston Road would destroy businesses that have been here for 40 years!" },
              { name: "Planning Commission", role: "Final Verdict", color: "#818cf8", text: "Approved. Scarborough Town Centre confirmed as terminus. 8 stops adopted." },
            ].map((agent, i) => (
              <div key={i} style={{ display: "flex", gap: 10, marginBottom: 12 }}>
                <div style={{ width: 30, height: 30, borderRadius: "50%", backgroundColor: agent.color, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <span style={{ color: "white", fontSize: 11, fontWeight: 700 }}>{agent.name[0]}</span>
                </div>
                <div style={{ backgroundColor: "rgba(255,255,255,0.06)", borderRadius: 10, padding: "8px 12px", flex: 1 }}>
                  <p style={{ fontSize: 10, color: agent.color, fontWeight: 700, marginBottom: 3, textTransform: "uppercase", letterSpacing: "0.06em" }}>{agent.name}</p>
                  <p style={{ fontSize: 12.5, color: "rgba(255,255,255,0.72)", lineHeight: 1.6 }}>{agent.text}</p>
                </div>
              </div>
            ))}

            {/* Route preview strip at bottom */}
            <div style={{ marginTop: 16, padding: "14px 16px", backgroundColor: "rgba(255,255,255,0.04)", borderRadius: 10, display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ display: "flex", gap: 3, alignItems: "center" }}>
                {["#dc2626","#d97706","#2563eb","#16a34a","#818cf8","#0891b2","#dc2626","#d97706"].map((c,i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 0 }}>
                    <div style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: c, border: "1.5px solid rgba(255,255,255,0.2)" }} />
                    {i < 7 && <div style={{ width: 12, height: 2, backgroundColor: "rgba(255,255,255,0.12)" }} />}
                  </div>
                ))}
              </div>
              <span style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginLeft: 6 }}>Scarborough East Subway · 8 stops</span>
            </div>
          </div>

          {/* Text side */}
          <div>
            <p style={{ fontSize: 11.5, fontWeight: 700, color: isDark ? "#818cf8" : "#3730a3", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 18 }}>
              AI Planning Council
            </p>
            <h2 style={{ fontFamily: '"Google Sans Display", Georgia, serif', fontSize: "clamp(2rem, 3.5vw, 3.2rem)", fontWeight: 700, color: isDark ? "#ffffff" : "#0f0e17", letterSpacing: "-0.03em", lineHeight: 1.08, marginBottom: 24 }}>
              Six agents.<br />One optimal route.
            </h2>
            <p style={{ fontSize: 16, color: isDark ? "#d1d5db" : "#57534e", lineHeight: 1.8, marginBottom: 36 }}>
              A transit planner, cost analyst, NIMBY resident, PR director, and planning commission debate every stop — streaming live as they deliberate. The result is a route that's already been stress-tested.
            </p>
            <Link href="/map" style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "14px 28px", borderRadius: 999, backgroundColor: "#0f0e17", color: "#ffffff", fontSize: 15, fontWeight: 600, textDecoration: "none", letterSpacing: "-0.01em" }}>
              See it in action
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M12 5l7 7-7 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </Link>
          </div>
        </section>

        {/* ── 2. Dark "Designed for every planner" card ────────────────────── */}
        <section style={{ padding: "0 clamp(20px, 5vw, 64px) 120px", maxWidth: 1280, margin: "0 auto" }}>
          <div style={{ backgroundColor: "#0f0e17", borderRadius: 32, padding: "clamp(40px, 6vw, 80px) clamp(20px, 5vw, 72px)", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(340px, 100%), 1fr))", gap: 80, alignItems: "start" }}>

            {/* Left: headline + tag pills */}
            <div>
              <h2 style={{ fontFamily: '"Google Sans Display", Georgia, serif', fontSize: "clamp(2.8rem, 5vw, 5rem)", fontWeight: 700, color: "#ffffff", letterSpacing: "-0.035em", lineHeight: 1.0, marginBottom: 48 }}>
                Built for<br /><span style={{ color: "#818cf8" }}>everyone</span>
              </h2>
              {/* 📖 Learn: these pill tags work like the "iPhone / Mac / Windows" pills in the Flow screenshot */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {[
                  { label: "Enthusiasts", active: true },
                  { label: "Students" },
                  { label: "Advocates" },
                  { label: "Urban Planners" },
                  { label: "Researchers" },
                  { label: "City Officials" },
                  { label: "Infrastructure Teams" },
                ].map(({ label, active }) => (
                  <span key={label} style={{ padding: "8px 18px", borderRadius: 999, fontSize: 13.5, fontWeight: 500, backgroundColor: active ? "#ffffff" : "transparent", color: active ? "#0f0e17" : "rgba(255,255,255,0.55)", border: `1.5px solid ${active ? "#ffffff" : "rgba(255,255,255,0.2)"}` }}>
                    {label}
                  </span>
                ))}
              </div>
            </div>

            {/* Right: description for the active/highlighted tag */}
            <div style={{ paddingTop: 8 }}>
              <h3 style={{ fontFamily: '"Google Sans Display", Georgia, serif', fontSize: "clamp(1.5rem, 2.5vw, 2rem)", fontWeight: 700, color: "#ffffff", letterSpacing: "-0.02em", marginBottom: 16 }}>
                For everyone who&apos;s thought &ldquo;they should build a line here&rdquo;
              </h3>
              <p style={{ fontSize: 16, color: "rgba(255,255,255,0.58)", lineHeight: 1.8, marginBottom: 36 }}>
                Draw the route you&apos;ve always imagined on a live map of Toronto&apos;s transit network. Drop stops, pick a line type, and watch an AI council debate whether it actually works — cost, ridership, and neighbourhood impact included.
              </p>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                <Link href="/map" style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "12px 24px", borderRadius: 999, backgroundColor: "#ffffff", color: "#0f0e17", fontSize: 14, fontWeight: 600, textDecoration: "none" }}>
                  Open app
                </Link>
                <Link href="/docs" style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "12px 24px", borderRadius: 999, backgroundColor: "transparent", color: "rgba(255,255,255,0.7)", fontSize: 14, fontWeight: 500, textDecoration: "none", border: "1.5px solid rgba(255,255,255,0.2)" }}>
                  Read docs
                </Link>
                <a href="https://github.com/evanzyang91/transit-planner" target="_blank" rel="noopener noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "12px 24px", borderRadius: 999, backgroundColor: "transparent", color: "rgba(255,255,255,0.7)", fontSize: 14, fontWeight: 500, textDecoration: "none", border: "1.5px solid rgba(255,255,255,0.2)" }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844a9.59 9.59 0 012.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.942.359.31.678.921.678 1.856 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"/></svg>
                  GitHub
                </a>
              </div>
            </div>
          </div>
        </section>

        {/* ── 3. Staggered feature blocks ──────────────────────────────────── */}
        {/* Feature A: Draw any corridor */}
        <section style={{ maxWidth: 1280, margin: "0 auto", padding: "0 clamp(20px, 5vw, 64px) 100px", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(400px, 100%), 1fr))", gap: 80, alignItems: "center" }}>
          {/* Mockup: simplified route drawing */}
          <div style={{ backgroundColor: "#111827", borderRadius: 24, padding: 28, aspectRatio: "4/3", display: "flex", flexDirection: "column", overflow: "hidden", border: isDark ? "1px solid rgba(255,255,255,0.10)" : "1px solid transparent" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 18 }}>
              {["#ef4444","#f59e0b","#22c55e"].map(c => <div key={c} style={{ width: 9, height: 9, borderRadius: "50%", backgroundColor: c }} />)}
            </div>
            {/* Simulated map grid */}
            <div style={{ flex: 1, position: "relative", backgroundImage: "linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px)", backgroundSize: "32px 32px" }}>
              {/* Route lines */}
              <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} viewBox="0 0 320 220" preserveAspectRatio="none">
                <polyline points="20,110 80,90 140,100 200,75 260,80 300,70" fill="none" stroke="#2563eb" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
                <polyline points="20,160 60,140 100,145 160,130 220,140 300,120" fill="none" stroke="#dc2626" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
                <polyline points="60,20 70,60 65,110 70,160 60,200" fill="none" stroke="#16a34a" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
                {/* Stop dots on blue line */}
                {[[20,110],[80,90],[140,100],[200,75],[260,80],[300,70]].map(([x,y],i) => (
                  <circle key={i} cx={x} cy={y} r={5} fill="#111827" stroke="#2563eb" strokeWidth="2.5" />
                ))}
              </svg>
              {/* New stop being placed */}
              <div style={{ position: "absolute", top: "35%", left: "62%", width: 14, height: 14, borderRadius: "50%", backgroundColor: "#2563eb", border: "3px solid white", boxShadow: "0 0 0 4px rgba(37,99,235,0.3)" }} />
            </div>
          </div>

          <div>
            <p style={{ fontSize: 11.5, fontWeight: 700, color: isDark ? "#818cf8" : "#3730a3", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 18 }}>Map Editor</p>
            <h2 style={{ fontFamily: '"Google Sans Display", Georgia, serif', fontSize: "clamp(1.8rem, 3vw, 2.8rem)", fontWeight: 700, color: isDark ? "#ffffff" : "#0f0e17", letterSpacing: "-0.03em", lineHeight: 1.1, marginBottom: 20 }}>
              Draw any<br />corridor.
            </h2>
            <p style={{ fontSize: 15.5, color: isDark ? "#d1d5db" : "#57534e", lineHeight: 1.8 }}>
              Click to drop stops directly on the live TTC network. Subway, LRT, streetcar — sketch any corridor and watch your route come to life in real time, overlaid on every existing line.
            </p>
          </div>
        </section>

        {/* Feature B: GTFS (reversed — text left, mockup right) */}
        <section style={{ maxWidth: 1280, margin: "0 auto", padding: "0 clamp(20px, 5vw, 64px) 100px", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(400px, 100%), 1fr))", gap: 80, alignItems: "center" }}>
          <div>
            <p style={{ fontSize: 11.5, fontWeight: 700, color: isDark ? "#22c55e" : "#16a34a", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 18 }}>GTFS Round-Trip</p>
            <h2 style={{ fontFamily: '"Google Sans Display", Georgia, serif', fontSize: "clamp(1.8rem, 3vw, 2.8rem)", fontWeight: 700, color: isDark ? "#ffffff" : "#0f0e17", letterSpacing: "-0.03em", lineHeight: 1.1, marginBottom: 20 }}>
              Planning-ready<br />from day one.
            </h2>
            <p style={{ fontSize: 15.5, color: isDark ? "#d1d5db" : "#57534e", lineHeight: 1.8 }}>
              Export your route as a valid GTFS ZIP — the industry standard for transit data — or import an existing feed to continue editing. Every sketch becomes a deliverable.
            </p>
          </div>

          {/* Mockup: GTFS export UI */}
          <div style={{ backgroundColor: "#111827", borderRadius: 24, padding: 28, overflow: "hidden", border: isDark ? "1px solid rgba(255,255,255,0.10)" : "1px solid transparent" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 20 }}>
              {["#ef4444","#f59e0b","#22c55e"].map(c => <div key={c} style={{ width: 9, height: 9, borderRadius: "50%", backgroundColor: c }} />)}
            </div>
            {/* Simulated export dialog */}
            <div style={{ backgroundColor: "rgba(255,255,255,0.05)", borderRadius: 14, padding: "20px 20px 14px" }}>
              <p style={{ fontSize: 12, fontWeight: 600, color: "rgba(255,255,255,0.5)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 14 }}>GTFS Export</p>
              {[
                { file: "routes.txt", rows: "1 route", color: "#2563eb" },
                { file: "stops.txt", rows: "8 stops", color: "#16a34a" },
                { file: "trips.txt", rows: "14 trips", color: "#d97706" },
                { file: "stop_times.txt", rows: "112 entries", color: "#7c3aed" },
                { file: "shapes.txt", rows: "1 shape", color: "#0891b2" },
              ].map(({ file, rows, color }) => (
                <div key={file} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ width: 6, height: 6, borderRadius: "50%", backgroundColor: color }} />
                    <span style={{ fontSize: 12.5, color: "rgba(255,255,255,0.7)", fontFamily: "monospace" }}>{file}</span>
                  </div>
                  <span style={{ fontSize: 11.5, color: "rgba(255,255,255,0.35)" }}>{rows}</span>
                </div>
              ))}
              <div style={{ marginTop: 16, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ fontSize: 11.5, color: "rgba(255,255,255,0.35)" }}>Validated ✓</span>
                <div style={{ backgroundColor: "#16a34a", color: "white", fontSize: 12, fontWeight: 600, padding: "6px 16px", borderRadius: 999 }}>Download ZIP</div>
              </div>
            </div>
          </div>
        </section>

        {/* Feature C: Population data */}
        <section style={{ maxWidth: 1280, margin: "0 auto", padding: "0 clamp(20px, 5vw, 64px) 120px", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(400px, 100%), 1fr))", gap: 80, alignItems: "center" }}>
          {/* Mockup: population heatmap over stops */}
          <div style={{ backgroundColor: "#111827", borderRadius: 24, padding: 28, aspectRatio: "4/3", position: "relative", overflow: "hidden", border: isDark ? "1px solid rgba(255,255,255,0.10)" : "1px solid transparent" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 18 }}>
              {["#ef4444","#f59e0b","#22c55e"].map(c => <div key={c} style={{ width: 9, height: 9, borderRadius: "50%", backgroundColor: c }} />)}
            </div>
            {/* Simulated heatmap blobs */}
            <div style={{ position: "relative", flex: 1, height: "calc(100% - 48px)", backgroundImage: "linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)", backgroundSize: "28px 28px" }}>
              {[
                { x: "22%", y: "30%", size: 90, opacity: 0.35, color: "#dc2626" },
                { x: "55%", y: "45%", size: 120, opacity: 0.4, color: "#dc2626" },
                { x: "75%", y: "25%", size: 70, opacity: 0.25, color: "#d97706" },
                { x: "38%", y: "65%", size: 80, opacity: 0.3, color: "#d97706" },
                { x: "68%", y: "70%", size: 60, opacity: 0.2, color: "#2563eb" },
              ].map((blob, i) => (
                <div key={i} style={{ position: "absolute", left: blob.x, top: blob.y, width: blob.size, height: blob.size, borderRadius: "50%", backgroundColor: blob.color, opacity: blob.opacity, filter: "blur(22px)", transform: "translate(-50%,-50%)" }} />
              ))}
              {/* Stat pill */}
              <div style={{ position: "absolute", top: "18%", right: "8%", backgroundColor: "rgba(255,255,255,0.08)", backdropFilter: "blur(8px)", borderRadius: 10, padding: "8px 14px", border: "1px solid rgba(255,255,255,0.1)" }}>
                <p style={{ fontSize: 10, color: "rgba(255,255,255,0.45)", marginBottom: 2 }}>Est. catchment</p>
                <p style={{ fontSize: 18, fontWeight: 700, color: "#ffffff" }}>124,800</p>
              </div>
            </div>
          </div>

          <div>
            <p style={{ fontSize: 11.5, fontWeight: 700, color: isDark ? "#ef4444" : "#dc2626", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 18 }}>Population Data</p>
            <h2 style={{ fontFamily: '"Google Sans Display", Georgia, serif', fontSize: "clamp(1.8rem, 3vw, 2.8rem)", fontWeight: 700, color: isDark ? "#ffffff" : "#0f0e17", letterSpacing: "-0.03em", lineHeight: 1.1, marginBottom: 20 }}>
              Every stop has a<br />catchment score.
            </h2>
            <p style={{ fontSize: 15.5, color: isDark ? "#d1d5db" : "#57534e", lineHeight: 1.8 }}>
              Population density and neighbourhood data are baked in. Each station shows an estimated catchment and the council uses it automatically — no spreadsheets required.
            </p>
          </div>
        </section>

        {/* ── 4. "Design the next line" — cinematic CTA before footer ────── */}
        <section
          style={{
            position: "relative",
            minHeight: "80vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
            borderRadius: 40,
            margin: "0 clamp(12px, 4vw, 48px)",
          }}
        >
          <div
            style={{
              position: "absolute", inset: 0,
              backgroundImage: "url('/transit-night.png')",
              backgroundSize: "cover",
              backgroundPosition: "center 40%",
            }}
          />
          <div
            style={{
              position: "absolute", inset: 0,
              background: "linear-gradient(to bottom, rgba(0,0,0,0.18) 0%, rgba(0,0,0,0.55) 100%)",
            }}
          />
          <div
            style={{
              position: "relative", zIndex: 1,
              textAlign: "center",
              padding: "100px 24px 120px",
              maxWidth: 960,
            }}
          >
            <h2
              style={{
                fontFamily: '"Google Sans Display", Georgia, serif',
                fontSize: "clamp(3.5rem, 10vw, 8.5rem)",
                fontWeight: 700,
                color: "#ffffff",
                lineHeight: 0.95,
                letterSpacing: "-0.035em",
                marginBottom: 48,
              }}
            >
              Design the<br />next line.
            </h2>
            <Link
              href="/map"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 10,
                padding: "18px 36px",
                borderRadius: 999,
                backgroundColor: "#ffffff",
                color: "#0f0e17",
                fontSize: 17,
                fontWeight: 600,
                textDecoration: "none",
                letterSpacing: "-0.01em",
                boxShadow: "0 4px 24px rgba(0,0,0,0.25)",
              }}
            >
              Start planning
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M5 12h14M12 5l7 7-7 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </Link>
          </div>
        </section>

        {/* ── 5. Footer — large brand text + links ─────────────────────────── */}
        <footer style={{ borderTop: isDark ? "1px solid #374151" : "1px solid #e8e4dc", padding: "72px clamp(20px, 5vw, 64px) 48px" }}>
          <div style={{ maxWidth: 1280, margin: "0 auto" }}>
            {/* Links row */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 40, marginBottom: 96 }}>
              {[
                { heading: "Product", links: [{ label: "Open App", href: "/map" }, { label: "About", href: "/about" }, { label: "Docs", href: "/docs" }] },
                { heading: "Resources", links: [{ label: "User Guide", href: "/docs/user" }, { label: "Technical Docs", href: "/docs/technical" }, { label: "Terms of Use", href: "/terms" }] },
                { heading: "Legal", links: [{ label: "Privacy Policy", href: "/privacy" }, { label: "Terms", href: "/terms" }] },
              ].map(col => (
                <div key={col.heading}>
                  <p style={{ fontSize: 11.5, fontWeight: 700, color: isDark ? "#9ca3af" : "#a8a29e", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 16 }}>{col.heading}</p>
                  {col.links.map(link => (
                    <Link key={link.href} href={link.href} style={{ display: "block", fontSize: 14, color: isDark ? "#d1d5db" : "#57534e", textDecoration: "none", marginBottom: 10 }}>{link.label}</Link>
                  ))}
                </div>
              ))}
            </div>

            {/* Large brand name — like the Flow footer */}
            <div style={{ overflow: "hidden" }}>
              <h2 style={{ fontFamily: '"Google Sans Display", Georgia, serif', fontSize: "clamp(5rem, 15vw, 14rem)", fontWeight: 700, color: isDark ? "#ffffff" : "#0f0e17", letterSpacing: "-0.04em", lineHeight: 0.88, margin: "0 -4px" }}>
                Transit Planner
              </h2>
            </div>

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 32, paddingTop: 24, borderTop: isDark ? "1px solid #374151" : "1px solid #e8e4dc" }}>
              <p style={{ fontSize: 12.5, color: isDark ? "#9ca3af" : "#a8a29e" }}>© Transit Planner 2026</p>
              {/* Toggle dark/light mode — mirrors the TransitMap pattern: flip html.dark class + persist to localStorage */}
              <button
                onClick={() => {
                  const next = !isDark;
                  document.documentElement.classList.toggle("dark", next);
                  localStorage.setItem("darkMode", next ? "1" : "0");
                }}
                aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
                style={{
                  background: "none", border: "none", cursor: "pointer", padding: 6,
                  color: isDark ? "#9ca3af" : "#a8a29e", display: "flex", alignItems: "center",
                  borderRadius: 6, transition: "color 0.2s",
                }}
              >
                {isDark ? (
                  // Sun icon
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="5"/>
                    <line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>
                    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
                    <line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>
                    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
                  </svg>
                ) : (
                  // Moon icon
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
                  </svg>
                )}
              </button>
            </div>
          </div>
        </footer>

      </div>{/* end cream feature wrapper */}
    </main>
  );
}
