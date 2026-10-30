/**
 * Sanitizing untrusted text. Anything that comes from the web (news, market descriptions, source
 * titles) is data: it's cleaned before it is stored, streamed to the dashboard, or put in a prompt.
 */

// Control characters (except tab/newline), zero-width and bidi-override characters that can hide
// or reorder text, plus the private-use "tag" block sometimes used to smuggle invisible instructions.
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁠-⁤⁦-⁩﻿]|[\u{E0000}-\u{E007F}]/gu

/** Streamed model text: invisible characters out, line breaks normalized, spacing kept (a piece of a stream must not be trimmed). */
export const stripInvisible = (value: string) => value.replace(INVISIBLE, "").replace(/\r\n?/g, "\n")

export const cleanText = (value: unknown, maxLength = 2_000): string => {
  if (typeof value !== "string") return ""
  const cleaned = value.replace(INVISIBLE, "").replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").trim()
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}…` : cleaned
}

/** Single-line version for titles and summaries. */
export const cleanLine = (value: unknown, maxLength = 200) => cleanText(value, maxLength * 2).replace(/\s*\n\s*/g, " ").slice(0, maxLength)

/** Only absolute http(s) URLs survive; everything else (javascript:, data:, relative) becomes null. */
export const cleanUrl = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length > 2_000) return null
  try {
    const url = new URL(value.trim())
    if (url.protocol !== "https:" && url.protocol !== "http:") return null
    url.username = ""
    url.password = ""
    return url.toString()
  } catch {
    return null
  }
}

export const domainOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return ""
  }
}

/**
 * Wraps untrusted text for a prompt. The fence makes the boundary explicit, and any fence-like
 * sequences inside the data are neutralized so the content can't "close" the block early.
 */
export const fenceUntrusted = (label: string, content: string) => {
  const body = cleanText(content, 20_000).replace(/<\/?untrusted[^>]*>/gi, "[tag removed]")
  return `<untrusted source="${label}">\n${body}\n</untrusted>`
}
