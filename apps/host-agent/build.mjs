import { execFileSync } from "node:child_process"
import { build } from "esbuild"

/** The commit the bundle is built from, shown on Admin → Server. */
const version = (() => {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim()
  } catch {
    return "dev"
  }
})()

/**
 * Bundles the host agent into plain JavaScript for the Windows server's own Node (docs/SERVER.md
 * §11): the agent, the fan watchdog it starts as a separate process, and the one-off history import.
 *
 * As in the engines' bundles, the MongoDB driver's optional native add-ons are external and simply
 * aren't installed, which the driver handles.
 */
await build({
  entryPoints: ["src/main.ts", "src/fan-watchdog.ts", "src/import-history.ts"],
  outdir: "dist",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  legalComments: "none",
  define: { "process.env.HOST_AGENT_VERSION": JSON.stringify(version) },
  external: ["kerberos", "snappy", "socks", "aws4", "mongodb-client-encryption", "gcp-metadata", "@aws-sdk/credential-providers", "@mongodb-js/zstd"],
  // ESM bundles of CommonJS deps still call require() for Node built-ins.
  banner: {
    js: "import { createRequire as __mbCreateRequire } from 'node:module'; const require = __mbCreateRequire(import.meta.url);",
  },
})
console.log("built dist/main.js, dist/fan-watchdog.js, dist/import-history.js")
