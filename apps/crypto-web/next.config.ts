import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  // A self-contained server (.next/standalone) for the web image (docker/web/Dockerfile). The trace
  // starts at the repo root (the lockfile's folder), so the workspace packages are in it.
  output: "standalone",
  // The shared packages ship TypeScript sources.
  transpilePackages: ["@mb/core", "@mb/crypto-core", "@mb/ui", "@mb/web-kit"],
  poweredByHeader: false,
  // The rate limit (proxy.ts) tells link prefetches by Next's router headers, which Next otherwise
  // removes before the proxy runs. The proxy only lets requests through or refuses them, so the URL
  // normalization this also skips (for proxy rewrites, redirects and locales) changes nothing here.
  skipProxyUrlNormalize: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async redirects() {
    return [
      // System and Controls merged into the owner-only Admin page; the public engine summary lives on the overview.
      { source: "/system", destination: "/", permanent: true },
      { source: "/settings", destination: "/admin", permanent: true },
    ]
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
