import "server-only"
import { createHash, randomUUID } from "node:crypto"
import { mongodbAdapter } from "@better-auth/mongo-adapter"
import { COLLECTIONS } from "@mb/stock-core/db"
import { betterAuth } from "better-auth"
import { magicLink } from "better-auth/plugins"
import { headers } from "next/headers"
import { cache } from "react"
import { collections, mongoClient } from "./db"
import { sendMagicLinkEmail } from "./email"
import { env } from "./env"
import { isOwnerEmail } from "./owner"

/**
 * Who is looking: the owner (signed in) or the public. Public viewers can read the dashboard
 * (it is paper money); every control, the settings page, the audit log and
 * operational details need the owner session.
 *
 * The owner signs in with a Better Auth magic link, emailed through useSend. Only OWNER_EMAIL gets
 * in, checked three times: no link is ever emailed to another address, no account can be created
 * for one, and a session only counts as the owner's while its email matches.
 */

export type Viewer = { owner: boolean }

const SESSION_TTL_SECONDS = 12 * 3_600
const MAGIC_LINK_TTL_SECONDS = 5 * 60

/** Sign-in needs BETTER_AUTH_SECRET (32+ chars) and MongoDB; without them everyone is public. */
export const authConfigured = () => (env.betterAuthSecret()?.length ?? 0) >= 32 && !!env.mongoUri()

/** Client IPs are only stored hashed. */
const hashIp = (value: string) => createHash("sha256").update(`smb-ip.${value}`).digest("hex").slice(0, 32)

const createAuth = () => {
  const client = mongoClient()
  return betterAuth({
    appName: "StockMarketBot",
    baseURL: env.siteUrl() ?? undefined,
    database: mongodbAdapter(client.db(env.mongoDb()), { client }),
    user: {
      modelName: COLLECTIONS.authUsers,
      validateUserInfo: ({ user }) => (isOwnerEmail(user.email, env.ownerEmail()) ? undefined : { error: "not_owner" }),
    },
    session: { modelName: COLLECTIONS.authSessions, expiresIn: SESSION_TTL_SECONDS },
    account: { modelName: COLLECTIONS.authAccounts },
    verification: { modelName: COLLECTIONS.authVerifications },
    // Stored in MongoDB so every serverless instance shares the limits (expires on its own).
    rateLimit: {
      customStorage: {
        consume: async (key, { window, max }) => {
          const { loginAttempts } = await collections()
          const now = new Date()
          const live = { $gt: ["$expires_at", now] }
          const doc = await loginAttempts.findOneAndUpdate(
            { _id: hashIp(key) },
            [
              {
                $set: {
                  // Start a fresh window if the previous one expired.
                  count: { $cond: [live, { $add: ["$count", 1] }, 1] },
                  first_at: { $cond: [live, "$first_at", now] },
                  expires_at: { $cond: [live, "$expires_at", new Date(now.getTime() + window * 1000)] },
                },
              },
            ],
            { upsert: true, returnDocument: "after" },
          )
          if (!doc || doc.count <= max) return { allowed: true, retryAfter: null }
          return { allowed: false, retryAfter: Math.max(1, Math.ceil((doc.expires_at.getTime() - now.getTime()) / 1000)) }
        },
      },
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => ({ data: { ...session, ipAddress: session.ipAddress ? hashIp(session.ipAddress) : null } }),
          after: async (session) => {
            const { audit } = await collections()
            await audit.insertOne({ _id: randomUUID(), at: new Date(), actor: "owner", action: "login", target: null, details: { client: session.ipAddress?.slice(0, 8) ?? null } })
          },
        },
      },
    },
    plugins: [
      magicLink({
        expiresIn: MAGIC_LINK_TTL_SECONDS,
        storeToken: "hashed",
        sendMagicLink: async ({ email, url }) => {
          // Anyone can ask for a link; only the owner is ever emailed one, and the response is the same either way.
          if (isOwnerEmail(email, env.ownerEmail())) await sendMagicLinkEmail({ to: email, url, minutes: MAGIC_LINK_TTL_SECONDS / 60 })
        },
      }),
    ],
  })
}

let instance: ReturnType<typeof createAuth> | undefined

/** Built on first use, so `next build` doesn't need the database or secrets. */
export const auth = () => (instance ??= createAuth())

export const getViewer = cache(async (): Promise<Viewer> => {
  if (!authConfigured()) return { owner: false }
  const session = await auth().api.getSession({ headers: await headers() })
  return { owner: isOwnerEmail(session?.user.email, env.ownerEmail()) }
})

/**
 * Rejects cross-site POSTs: browsers always send Origin on POST, and it must be this site.
 * Together with SameSite=Lax cookies this blocks CSRF against the command API.
 */
export const sameOrigin = async () => {
  const h = await headers()
  const origin = h.get("origin")
  const host = h.get("x-forwarded-host") ?? h.get("host")
  if (!origin || !host) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}
