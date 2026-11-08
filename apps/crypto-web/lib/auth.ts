import "server-only"
import { createAuth } from "@mb/web-kit/auth"
import { email } from "@mb/web-kit/email"
import { collections, mongoClient } from "./db"
import { env } from "./env"

export { sameOrigin, type Viewer } from "@mb/web-kit/auth"

/**
 * Owner sign-in (@mb/web-kit/auth): a Better Auth magic link (or, in the Home Screen app, an
 * emailed code) for OWNER_EMAIL only, with this dashboard's own secret, database and domain. The
 * IP salt "cmb-ip." must never change: the login rate-limit records are keyed by it.
 */
export const { auth, authConfigured, getViewer, isOwnerRequest } = createAuth({
  appName: "CryptoMarketBot",
  ipSalt: "cmb-ip.",
  env,
  mongoClient,
  collections,
  ...email({ appName: "CryptoMarketBot", env }),
})
