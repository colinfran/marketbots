import { defineConfig, globalIgnores } from "eslint/config"
import nextVitals from "eslint-config-next/core-web-vitals"
import nextTs from "eslint-config-next/typescript"
import tseslint from "typescript-eslint"

/**
 * Shared ESLint presets. Every package and app lints its imports against the dependency direction
 * in AGENTS.md:
 *
 *   @mb/core ← @mb/crypto-core / @mb/stock-core
 *   @mb/core ← @mb/engine-kit ← @mb/wire, @mb/history, @mb/agent
 *   @mb/core ← @mb/ui, @mb/web-kit
 *   apps depend on packages; packages never import apps; crypto never imports stock, or the reverse;
 *   the landing page imports only @mb/ui and @mb/web-kit.
 */

/** What each shared package may import (besides itself and @mb/config). */
const SHARED = {
  core: [],
  "engine-kit": ["core"],
  agent: ["core", "engine-kit"],
  history: ["core", "engine-kit"],
  wire: ["core", "engine-kit"],
  ui: ["core"],
  "web-kit": ["core"],
}

/** What each app outside the two bots may import (besides itself and @mb/config). */
const SITES = {
  landing: ["ui", "web-kit"],
}

const APPS = "@mb/((crypto|stock)-(engine|web)|landing)(/|$)"

/**
 * `no-restricted-imports` for one owner: "crypto" or "stock" (a bot's apps and core package), a
 * shared package name from SHARED, or an app name from SITES.
 */
export const boundaries = (owner) => {
  const patterns = [{ regex: `^${APPS}`, message: "Apps are never imported; move shared code into a package." }]
  if (owner === "crypto" || owner === "stock") {
    const other = owner === "crypto" ? "stock" : "crypto"
    patterns.push({ regex: `^@mb/${other}-`, message: `A ${owner} package or app never imports ${other} code.` })
  } else {
    const allowed = [owner, "config", ...(SHARED[owner] ?? SITES[owner] ?? [])].join("|")
    patterns.push({ regex: `^@mb/(?!(${allowed})(/|$))`, message: `@mb/${owner} may import only ${allowed.replaceAll("|", ", ")} (AGENTS.md, Package boundaries).` })
  }
  return { "no-restricted-imports": ["error", { patterns }] }
}

/** Engines and plain TypeScript packages: the import boundaries only. */
export const nodeConfig = (owner) =>
  defineConfig([
    globalIgnores(["dist/**", "coverage/**"]),
    {
      files: ["**/*.{ts,mts,mjs,js}"],
      languageOptions: { parser: tseslint.parser },
      rules: boundaries(owner),
    },
  ])

/** Next.js dashboards: Next's core-web-vitals + TypeScript presets, plus the import boundaries. */
export const nextConfig = (owner) =>
  defineConfig([
    ...nextVitals,
    ...nextTs,
    // Override default ignores of eslint-config-next.
    globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "old/**", "coverage/**"]),
    { rules: boundaries(owner) },
  ])
