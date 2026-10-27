import { toNextJsHandler } from "better-auth/next-js"
import { NextResponse } from "next/server"
import { auth, authConfigured } from "@/lib/auth"

// Better Auth: magic-link sign-in, link verification, sign-out (see lib/auth.ts).
export const { GET, POST } = toNextJsHandler(async (request) =>
  authConfigured()
    ? auth().handler(request)
    : NextResponse.json({ message: "Owner sign-in is not configured (BETTER_AUTH_SECRET / MONGODB_URI)." }, { status: 503 }),
)
