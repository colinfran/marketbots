import { build } from "esbuild"

/**
 * Bundles the engine (and the workspace's TypeScript sources) into one ESM file for the Docker
 * image, so production runs plain JavaScript with no build tooling.
 *
 * The MongoDB driver and ws load optional native add-ons inside try/catch; those are marked
 * external and simply aren't installed, which both libraries handle. (saslprep is a real
 * dependency, needed for SCRAM auth, so it is bundled.)
 */
await build({
  entryPoints: ["src/main.ts", "src/backtest/cli.ts"],
  outdir: "dist",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  legalComments: "none",
  external: [
    "kerberos",
    "snappy",
    "socks",
    "aws4",
    "mongodb-client-encryption",
    "gcp-metadata",
    "@aws-sdk/credential-providers",
    "@mongodb-js/zstd",
    "bufferutil",
    "utf-8-validate",
  ],
  // ESM bundles of CommonJS deps still call require() for Node built-ins.
  banner: {
    js: "import { createRequire as __cmbCreateRequire } from 'node:module'; const require = __cmbCreateRequire(import.meta.url);",
  },
})
console.log("built dist/main.js and dist/backtest/cli.js")
