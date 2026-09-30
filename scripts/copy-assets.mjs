// Copies runtime files that the bundler doesn't emit into public/, so they are
// served as-is and always match the installed package versions.
import { copyFileSync, cpSync, rmSync } from "node:fs";

copyFileSync("node_modules/@wllama/wllama/esm/wasm/wllama.wasm", "public/wllama.wasm");

// Cesium loads its web workers, widget CSS/images and third-party code at runtime
// from CESIUM_BASE_URL (/cesium).
rmSync("public/cesium", { recursive: true, force: true });
for (const dir of ["Workers", "ThirdParty", "Assets", "Widgets"]) {
  cpSync(`node_modules/cesium/Build/Cesium/${dir}`, `public/cesium/${dir}`, { recursive: true });
}
