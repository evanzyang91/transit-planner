"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, Suspense } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import * as THREE from "three";

// ── Lat/lon grid overlay ──────────────────────────────────────────────────────
function GlobeGrid({ radius }: { radius: number }) {
  const geometry = useMemo(() => {
    const pts: number[] = [];
    const S = 64;

    // Latitude circles
    for (let lat = -80; lat <= 80; lat += 20) {
      const phi = (lat * Math.PI) / 180;
      const y = radius * Math.sin(phi);
      const r = radius * Math.cos(phi);
      for (let i = 0; i < S; i++) {
        const a1 = (i / S) * Math.PI * 2;
        const a2 = ((i + 1) / S) * Math.PI * 2;
        pts.push(r * Math.cos(a1), y, r * Math.sin(a1));
        pts.push(r * Math.cos(a2), y, r * Math.sin(a2));
      }
    }

    // Longitude arcs
    const LS = 36;
    for (let lon = 0; lon < 360; lon += 20) {
      const theta = (lon * Math.PI) / 180;
      for (let i = 0; i < LS; i++) {
        const phi1 = (i / LS - 0.5) * Math.PI;
        const phi2 = ((i + 1) / LS - 0.5) * Math.PI;
        pts.push(
          radius * Math.cos(phi1) * Math.cos(theta),
          radius * Math.sin(phi1),
          radius * Math.cos(phi1) * Math.sin(theta),
        );
        pts.push(
          radius * Math.cos(phi2) * Math.cos(theta),
          radius * Math.sin(phi2),
          radius * Math.cos(phi2) * Math.sin(theta),
        );
      }
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }, [radius]);

  return (
    <lineSegments geometry={geometry}>
      <lineBasicMaterial color="#b0a898" transparent opacity={0.22} />
    </lineSegments>
  );
}

// ── Spinning globe ────────────────────────────────────────────────────────────
function Globe() {
  const groupRef = useRef<THREE.Group>(null);
  const R = 3;

  useFrame(({ clock }) => {
    if (groupRef.current) {
      groupRef.current.rotation.y = clock.getElapsedTime() * 0.055;
    }
  });

  return (
    <group ref={groupRef} position={[0, -1, 0]}>
      <mesh>
        <sphereGeometry args={[R, 72, 72]} />
        <meshStandardMaterial color="#eae5d8" roughness={0.92} metalness={0} />
      </mesh>
      <GlobeGrid radius={R + 0.012} />
    </group>
  );
}

// ── Orbiting subway train ─────────────────────────────────────────────────────
function Train() {
  const groupRef = useRef<THREE.Group>(null);
  const angle = useRef(Math.PI * 0.6);
  const ORBIT_R = 3.22;
  const TILT = Math.PI / 5.5; // ~33° inclined orbit
  const sinT = Math.sin(TILT);
  const cosT = Math.cos(TILT);
  const GLOBE_Y = -1;

  useFrame((_, delta) => {
    angle.current += delta * 0.42;
    const a = angle.current;
    if (!groupRef.current) return;

    const x = ORBIT_R * Math.cos(a);
    const y = ORBIT_R * sinT * Math.sin(a) + GLOBE_Y;
    const z = ORBIT_R * cosT * Math.sin(a);

    groupRef.current.position.set(x, y, z);

    // Tangent along orbit
    const tangent = new THREE.Vector3(
      -ORBIT_R * Math.sin(a),
      ORBIT_R * sinT * Math.cos(a),
      ORBIT_R * cosT * Math.cos(a),
    ).normalize();

    // Outward normal from globe center
    const normal = new THREE.Vector3(x, y - GLOBE_Y, z).normalize();
    const binormal = new THREE.Vector3()
      .crossVectors(tangent, normal)
      .normalize();

    groupRef.current.setRotationFromMatrix(
      new THREE.Matrix4().makeBasis(tangent, normal, binormal),
    );
  });

  return (
    <group ref={groupRef}>
      {/* Car 1 body */}
      <mesh position={[0.22, 0.07, 0]}>
        <boxGeometry args={[0.38, 0.1, 0.17]} />
        <meshStandardMaterial color="#1a1a1a" roughness={0.28} metalness={0.65} />
      </mesh>
      {/* Car 2 body */}
      <mesh position={[-0.24, 0.07, 0]}>
        <boxGeometry args={[0.36, 0.1, 0.17]} />
        <meshStandardMaterial color="#161616" roughness={0.28} metalness={0.65} />
      </mesh>
      {/* Coupling */}
      <mesh position={[0, 0.065, 0]}>
        <boxGeometry args={[0.07, 0.048, 0.11]} />
        <meshStandardMaterial color="#111" roughness={0.5} metalness={0.4} />
      </mesh>
      {/* Window strip – car 1 */}
      <mesh position={[0.22, 0.092, 0.086]}>
        <boxGeometry args={[0.27, 0.044, 0.001]} />
        <meshStandardMaterial
          color="#c5e8ff"
          roughness={0.05}
          metalness={0.9}
          transparent
          opacity={0.88}
        />
      </mesh>
      {/* Window strip – car 2 */}
      <mesh position={[-0.24, 0.092, 0.086]}>
        <boxGeometry args={[0.25, 0.044, 0.001]} />
        <meshStandardMaterial
          color="#c5e8ff"
          roughness={0.05}
          metalness={0.9}
          transparent
          opacity={0.88}
        />
      </mesh>
      {/* Headlight */}
      <mesh position={[0.42, 0.072, 0]}>
        <boxGeometry args={[0.01, 0.025, 0.06]} />
        <meshStandardMaterial color="#fffde8" emissive="#fffde8" emissiveIntensity={1.5} />
      </mesh>
    </group>
  );
}

// ── 3D scene ──────────────────────────────────────────────────────────────────
function Scene() {
  return (
    <>
      <ambientLight intensity={1.6} />
      <directionalLight position={[6, 9, 6]} intensity={0.6} />
      <directionalLight position={[-5, -2, -4]} intensity={0.1} color="#ede8de" />
      <Globe />
      <Train />
    </>
  );
}

// ── Landing page ──────────────────────────────────────────────────────────────
export default function LandingPage() {
  const [ready, setReady] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setReady(true);
    const t = setTimeout(() => setVisible(true), 60);
    return () => clearTimeout(t);
  }, []);

  const fadeUp = (delay: string) => ({
    opacity: visible ? 1 : 0,
    transform: visible ? "translateY(0)" : "translateY(18px)",
    transition: `opacity 1s ease ${delay}, transform 1s ease ${delay}`,
  });

  const fadeDown = (delay: string) => ({
    opacity: visible ? 1 : 0,
    transform: visible ? "translateY(0)" : "translateY(-10px)",
    transition: `opacity 0.8s ease ${delay}, transform 0.8s ease ${delay}`,
  });

  return (
    <main
      className="relative min-h-screen overflow-hidden"
      style={{ background: "#f5f3ee", fontFamily: "'Google Sans', sans-serif" }}
    >
      {/* Dot grid background */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage: "radial-gradient(circle, #c4bdb2 1px, transparent 1px)",
          backgroundSize: "28px 28px",
          opacity: 0.42,
        }}
      />

      {/* 3D globe canvas — full screen, behind everything */}
      {ready && (
        <div className="absolute inset-0">
          <Canvas
            camera={{ position: [0, 4, 9], fov: 44 }}
            onCreated={({ camera }) => camera.lookAt(0, -1, 0)}
            gl={{ antialias: true, alpha: true }}
            style={{ background: "transparent" }}
          >
            <Suspense fallback={null}>
              <Scene />
            </Suspense>
          </Canvas>
        </div>
      )}

      {/* Bottom gradient fade — blends globe into bg */}
      <div
        className="pointer-events-none absolute bottom-0 left-0 right-0 z-20 h-32"
        style={{ background: "linear-gradient(to top, #f5f3ee 20%, transparent)" }}
      />

      {/* UI layer */}
      <div className="relative z-10 flex min-h-screen flex-col">

        {/* Nav */}
        <header className="flex items-center justify-between px-8 py-7">
          <span
            className="text-[10px] font-medium uppercase tracking-[0.28em] text-neutral-400"
            style={fadeDown("0s")}
          >
            TP / 2025
          </span>
          <Link
            href="/map"
            className="text-[10px] uppercase tracking-[0.22em] text-neutral-400 transition-colors hover:text-neutral-800"
            style={fadeDown("0.1s")}
          >
            Open Map →
          </Link>
        </header>

        {/* Hero */}
        <div className="-mt-12 flex flex-1 flex-col items-center justify-center px-6 pb-16">

          {/* Eyebrow */}
          <p
            className="mb-7 text-[9px] uppercase tracking-[0.48em] text-neutral-400"
            style={fadeUp("0.2s")}
          >
            Urban Transit Intelligence
          </p>

          {/* Title */}
          <h1
            className="mb-10 select-none text-center font-black leading-[0.87] text-neutral-900"
            style={{
              fontSize: "clamp(4rem, 13.5vw, 11rem)",
              letterSpacing: "-0.035em",
              ...fadeUp("0.32s"),
            }}
          >
            Transit
            <br />
            Planner
          </h1>

          {/* CTA button */}
          <Link
            href="/map"
            className="group flex items-center gap-0.5 border border-neutral-300 bg-white/55 px-9 py-[14px] text-[10px] uppercase tracking-[0.24em] text-neutral-600 backdrop-blur-sm transition-all duration-300 hover:border-neutral-900 hover:bg-neutral-900 hover:text-white"
            style={fadeUp("0.46s")}
          >
            Let&apos;s Plan
            <span className="ml-0.5 font-mono text-neutral-300 transition-colors group-hover:text-neutral-500">
              ]
            </span>
          </Link>

          {/* Tagline */}
          <p
            className="mt-9 text-center text-[10px] uppercase tracking-[0.2em] text-neutral-400"
            style={{ opacity: visible ? 1 : 0, transition: "opacity 1s ease 0.65s" }}
          >
            A subway that rolls across the globe
          </p>
        </div>
      </div>
    </main>
  );
}
