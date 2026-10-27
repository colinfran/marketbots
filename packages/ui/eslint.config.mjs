import { nextConfig } from "@mb/config/eslint.mjs"

const config = [
  ...nextConfig("ui"),
  // A package has no pages directory (the rule is for the pages router).
  { rules: { "@next/next/no-html-link-for-pages": "off" } },
]

export default config
