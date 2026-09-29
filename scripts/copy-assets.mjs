// Copies runtime files that the bundler doesn't emit into public/, so they are
// served as-is and always match the installed package versions.
import { copyFileSync, mkdirSync } from "node:fs";

const files = [
  ["node_modules/@wllama/wllama/esm/wasm/wllama.wasm", "public/wllama.wasm"],
  // MapLibre 6 runs its worker from a separate module that imports the shared chunk.
  ["node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs", "public/maplibre/maplibre-gl-worker.mjs"],
  ["node_modules/maplibre-gl/dist/maplibre-gl-shared.mjs", "public/maplibre/maplibre-gl-shared.mjs"],
];

mkdirSync("public/maplibre", { recursive: true });
for (const [from, to] of files) copyFileSync(from, to);
