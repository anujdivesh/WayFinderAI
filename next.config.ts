import type { NextConfig } from "next";

// The app is served under this path (https://opmthredds.gem.spc.int/ocean-ai), in dev too.
// Next prefixes its own pages and assets; files in public/ are prefixed with asset() (src/app/asset.ts).
// Changing it needs a rebuild, and the nginx location and the Dockerfile health check to match.
const basePath = "/ocean-ai";

const nextConfig: NextConfig = {
  basePath,
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
  // A self-contained server in .next/standalone, for the Docker image (docker/Dockerfile).
  output: "standalone",
  // Cross-origin isolation enables SharedArrayBuffer, which wllama needs to run
  // on multiple CPU threads. Model downloads use CORS fetches, so they still work.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
        ],
      },
    ];
  },
};

export default nextConfig;
