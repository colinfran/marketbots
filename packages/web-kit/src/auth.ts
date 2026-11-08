import "server-only"
import { createHash, randomUUID } from "node:crypto"
import { mongodbAdapter } from "@better-auth/mongo-adapter"
import { type AuditDoc, BASE_COLLECTIONS, type LoginAttemptDoc } from "@mb/core/db"
import { betterAuth } from "better-auth"
import { toNextJsHandler } from "better-auth/next-js"
import { emailOTP, magicLink } from "better-auth/plugins"
import type { Collection, MongoClient } from "mongodb"
import { headers } from "next/headers"
import { NextResponse } from "next/server"
import { cache } from "react"
import type { DashboardEnv } from "./env"
import { isOwnerEmail } from "./owner"

/**
 * Who is looking: the owner (signed in) or the public. Public viewers can read the dashboard
 * (it's paper money); every control, the settings page, the audit log and operational details
 * need the owner session.
 *
 * The owner signs in with a Better Auth magic link, emailed through useSend. The dashboard installed
 * as a Home Screen app keeps its own cookies apart from the browser's, so an emailed link would sign
 * in the browser instead; there the owner types an emailed code (Better Auth email OTP). Only
 * OWNER_EMAIL gets in, checked three times: no link or code is ever emailed to another address, no
 * account can be created for one, and a session only counts as the owner's while its email matches.
 *
 * Each dashboard calls `createAuth` with its own name, secret, database, domain and IP salt.
 */

export type Viewer = { owner: boolean }

/** A fixed 30 days from sign-in: never extended by use. */
const SESSION_TTL_SECONDS = 30 * 86_400
/** How long a sign-in link or code works. */
const SIGN_IN_TTL_SECONDS = 5 * 60

/** The email OTP plugin's routes beyond signing in with a code: no use here, so they 404. */
export const UNUSED_OTP_PATHS = [
  "/email-otp/check-verification-otp",
  "/email-otp/verify-email",
  "/email-otp/request-password-reset",
  "/forget-password/email-otp",
  "/email-otp/reset-password",
  "/email-otp/request-email-change",
  "/email-otp/change-email",
]

/**
 * Client IPs are only stored hashed, with a per-bot salt ("cmb-ip." / "smb-ip."). The salt must
 * never change: the login rate-limit records are keyed by these hashes.
 */
export const hashIp = (salt: string, value: string) => createHash("sha256").update(`${salt}${value}`).digest("hex").slice(0, 32)

export const createAuth = ({
  appName,
  ipSalt,
  env,
  mongoClient,
  collections,
  sendMagicLinkEmail,
  sendSignInCodeEmail,
}: {
  appName: string
  ipSalt: string
  env: Pick<DashboardEnv, "betterAuthSecret" | "mongoUri" | "mongoDb" | "siteUrl" | "ownerEmail">
  mongoClient: () => MongoClient
  collections: () => Promise<{ loginAttempts: Collection<LoginAttemptDoc>; audit: Collection<AuditDoc> }>
  sendMagicLinkEmail: (message: { to: string; url: string; minutes: number }) => Promise<void>
  sendSignInCodeEmail: (message: { to: string; code: string; minutes: number }) => Promise<void>
}) => {
  /** Sign-in needs BETTER_AUTH_SECRET (32+ chars), MongoDB and OWNER_EMAIL; without them everyone is public. */
  const authConfigured = () => (env.betterAuthSecret()?.length ?? 0) >= 32 && !!env.mongoUri() && !!env.ownerEmail()

  const hash = (value: string) => hashIp(ipSalt, value)

  const build = () => {
    const client = mongoClient()
    return betterAuth({
      appName,
      baseURL: env.siteUrl() ?? undefined,
      database: mongodbAdapter(client.db(env.mongoDb()), { client }),
      user: {
        modelName: BASE_COLLECTIONS.authUsers,
        validateUserInfo: ({ user }) => (isOwnerEmail(user.email, env.ownerEmail()) ? undefined : { error: "not_owner" }),
      },
      session: { modelName: BASE_COLLECTIONS.authSessions, expiresIn: SESSION_TTL_SECONDS, disableSessionRefresh: true },
      account: { modelName: BASE_COLLECTIONS.authAccounts },
      verification: { modelName: BASE_COLLECTIONS.authVerifications },
      disabledPaths: UNUSED_OTP_PATHS,
      // Stored in MongoDB, so the limits survive a restart or a redeploy (expires on its own).
      rateLimit: {
        customStorage: {
          consume: async (key, { window, max }) => {
            const { loginAttempts } = await collections()
            const now = new Date()
            const live = { $gt: ["$expires_at", now] }
            const doc = await loginAttempts.findOneAndUpdate(
              { _id: hash(key) },
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
            before: async (session) => ({ data: { ...session, ipAddress: session.ipAddress ? hash(session.ipAddress) : null } }),
            after: async (session) => {
              const { audit } = await collections()
              await audit.insertOne({ _id: randomUUID(), at: new Date(), actor: "owner", action: "login", target: null, details: { client: session.ipAddress?.slice(0, 8) ?? null } })
            },
          },
        },
      },
      plugins: [
        magicLink({
          expiresIn: SIGN_IN_TTL_SECONDS,
          storeToken: "hashed",
          sendMagicLink: async ({ email, url }) => {
            // Anyone can ask for a link; only the owner is ever emailed one, and the response is the same either way.
            if (isOwnerEmail(email, env.ownerEmail())) await sendMagicLinkEmail({ to: email, url, minutes: SIGN_IN_TTL_SECONDS / 60 })
          },
        }),
        // 6 digits, single use, locked after 3 wrong tries; requests and tries are rate-limited per client.
        emailOTP({
          expiresIn: SIGN_IN_TTL_SECONDS,
          storeOTP: "hashed",
          sendVerificationOTP: async ({ email, otp, type }) => {
            // Same rule as the links. Only sign-in codes exist: the other OTP routes are disabled.
            if (type === "sign-in" && isOwnerEmail(email, env.ownerEmail())) await sendSignInCodeEmail({ to: email, code: otp, minutes: SIGN_IN_TTL_SECONDS / 60 })
          },
        }),
      ],
    })
  }

  let instance: ReturnType<typeof build> | undefined

  /** Built on first use, so `next build` doesn't need the database or secrets. */
  const auth = () => (instance ??= build())

  /** Whether a request's headers carry the owner's session: getViewer outside a request scope (the rate limit's proxy). */
  const isOwnerRequest = async (requestHeaders: Headers): Promise<boolean> => {
    if (!authConfigured()) return false
    const session = await auth().api.getSession({ headers: requestHeaders })
    return isOwnerEmail(session?.user.email, env.ownerEmail())
  }

  const getViewer = cache(async (): Promise<Viewer> => (authConfigured() ? { owner: await isOwnerRequest(await headers()) } : { owner: false }))

  return { auth, authConfigured, getViewer, isOwnerRequest }
}

/** app/api/auth/[...all]: magic-link and code sign-in, link verification, sign-out (503 until sign-in is configured). */
export const authRoute = ({ auth, authConfigured }: Pick<ReturnType<typeof createAuth>, "auth" | "authConfigured">) =>
  toNextJsHandler(async (request) =>
    authConfigured() ? auth().handler(request) : NextResponse.json({ message: "Owner sign-in is not configured (BETTER_AUTH_SECRET / MONGODB_URI / OWNER_EMAIL)." }, { status: 503 }),
  )

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
