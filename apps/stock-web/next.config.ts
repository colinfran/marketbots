import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  // A self-contained server (.next/standalone) for the web image (docker/web/Dockerfile). The trace
  // starts at the repo root (the lockfile's folder), so the workspace packages are in it.
  output: "standalone",
  // The shared packages ship TypeScript sources.
  transpilePackages: ["@mb/core", "@mb/stock-core", "@mb/ui", "@mb/web-kit"],
  poweredByHeader: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ]
  },
}

export default nextConfig
