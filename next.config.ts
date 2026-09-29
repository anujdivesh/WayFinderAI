import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
