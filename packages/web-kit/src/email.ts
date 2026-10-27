import "server-only"
import type { DashboardEnv } from "./env"

/** Outgoing email through useSend. A dashboard only ever sends the owner's sign-in links. */

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c)

export const email = ({ appName, env }: { appName: string; env: DashboardEnv }) => {
  const send = async (message: { to: string; subject: string; html: string; text: string }) => {
    const apiKey = env.usesendApiKey()
    if (!apiKey) throw new Error("USESEND_API_KEY is not set")
    const res = await fetch(`${env.usesendBaseUrl().replace(/\/+$/, "")}/api/v1/emails`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: env.usesendFrom(), ...message }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`useSend email delivery failed (HTTP ${res.status}): ${(await res.text()).slice(0, 500)}`)
  }

  const sendMagicLinkEmail = ({ to, url, minutes }: { to: string; url: string; minutes: number }) =>
    send({
      to,
      subject: `Sign in to ${appName}`,
      text: `Sign in to the ${appName} dashboard:\n\n${url}\n\nThe link works once and expires in ${minutes} minutes. If you didn't ask for it, ignore this email.`,
      html: `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: auto; padding: 24px; color: #111;">
      <h1 style="font-size: 20px; margin: 0 0 12px;">Sign in to ${appName}</h1>
      <p style="margin: 0 0 20px;">Use this button to sign in to the dashboard as the owner.</p>
      <p style="margin: 0 0 20px;"><a href="${escapeHtml(url)}" style="display: inline-block; background: #111; color: #fff; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-weight: 600;">Sign in</a></p>
      <p style="margin: 0; font-size: 13px; color: #666;">The link works once and expires in ${minutes} minutes. If you didn't ask for it, ignore this email.</p>
    </div>`,
    })

  return { sendMagicLinkEmail }
}
