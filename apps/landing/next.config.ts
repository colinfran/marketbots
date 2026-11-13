import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  // The shared packages ship TypeScript sources.
  transpilePackages: ["@mb/ui", "@mb/web-kit"],
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
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
      // Nothing may frame the site, except the embeds (app/embed/), which only colinfran.com may frame.
      { source: "/((?!embed/).*)", headers: [{ key: "X-Frame-Options", value: "DENY" }] },
      {
        source: "/embed/:path*",
        headers: [{ key: "Content-Security-Policy", value: "frame-ancestors 'self' https://colinfran.com https://www.colinfran.com http://localhost:*" }],
      },
    ]
  },
}

export default nextConfig
