// @ts-check
// prebuild setup script — runs before `next build`
// Uses CommonJS (no "type":"module" applies here since this is run directly by node)
const fs = require("fs");
const path = require("path");

// ── 1. Copy mapbox-gl.css to public/ ─────────────────────────────────────────
// mapbox-gl is hoisted to the monorepo root by npm workspaces, so its CSS
// lives outside the `web/` directory. Next.js's webpack CSS pipeline cannot
// process files from parent directories, so we serve it as a static file
// instead (referenced via <link> in layout.tsx).
const mapboxCssSrc = require.resolve("mapbox-gl/dist/mapbox-gl.css");
fs.copyFileSync(mapboxCssSrc, path.resolve(__dirname, "../public/mapbox-gl.css"));
console.log("✓ Copied mapbox-gl.css to public/");

// ── 2. Copy lightningcss native binary on Linux ───────────────────────────────
// lightningcss loads its compiled .node binary via a relative path:
//   require('../lightningcss.linux-x64-gnu.node')
// ...meaning it expects the file at <lightningcss-pkg-dir>/lightningcss.linux-x64-gnu.node
//
// But npm installs the binary in a SEPARATE optional package:
//   lightningcss-linux-x64-gnu/lightningcss.linux-x64-gnu.node
//
// So we copy it into place manually before the build.
// 📖 Learn: npm "optional dependencies" and NAPI-RS platform packages
if (process.platform === "linux") {
  try {
    // require.resolve('lightningcss') returns the package's main entry point:
    //   .../lightningcss/node/index.js
    // We go up one directory (out of node/) to reach the package root:
    //   .../lightningcss/
    // We can't use require.resolve('lightningcss/package.json') because the
    // package's "exports" field blocks access to package.json directly.
    // 📖 Learn: Node.js package "exports" field (subpath exports)
    const lightningcssNodeDir = path.dirname(require.resolve("lightningcss"));
    const lightningcssDir = path.resolve(lightningcssNodeDir, "..");

    const binaryName = "lightningcss.linux-x64-gnu.node";
    const dest = path.join(lightningcssDir, binaryName);

    if (!fs.existsSync(dest)) {
      // The platform binary package is installed as a sibling in node_modules:
      //   .../node_modules/lightningcss-linux-x64-gnu/lightningcss.linux-x64-gnu.node
      const platformPkgDir = path.resolve(lightningcssDir, "..", "lightningcss-linux-x64-gnu");
      const src = path.join(platformPkgDir, binaryName);

      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dest);
        console.log("✓ Copied lightningcss Linux binary into lightningcss package dir");
      } else {
        console.warn("⚠ lightningcss binary not found at:", src);
        console.warn("  Tailwind CSS compilation may fail.");
        console.warn("  platformPkgDir:", platformPkgDir);
        console.warn("  lightningcssDir:", lightningcssDir);
      }
    } else {
      console.log("✓ lightningcss Linux binary already in place");
    }
  } catch (e) {
    // `e` is `unknown` in a catch (TS strict + checkJs): only an Error has .message.
    console.warn("⚠ Could not copy lightningcss binary:", e instanceof Error ? e.message : String(e));
    console.warn("  Tailwind CSS compilation may fail.");
  }
}
