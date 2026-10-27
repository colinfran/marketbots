import { inflateRawSync } from "node:zlib"
import { errorMessage } from "@mb/engine-kit/log"
import { sleep } from "@mb/engine-kit/util/async"
import { HttpError } from "@mb/engine-kit/util/http"
import { marketDay } from "@mb/stock-core/time"
import { extractTextItems, getDocumentProxy } from "unpdf"
import { DEFAULT_USER_AGENT } from "../../util/http"
import { PollingSource } from "../poller"
import type { RawItem, SourceContext, SourceSpec } from "../types"
import { dayStart, isMissing, tracked, usDate } from "./common"

/**
 * Congressional stock trades (MASTER_PLAN §4.2 wave 3, `congress`), from the House Clerk's
 * financial-disclosure files (official, keyless), tier 3:
 *
 *   congress:house   every 6 hours: the year's filing index (a ~64 KB ZIP, updated daily) lists
 *                    every disclosure; new periodic transaction reports (FilingType P) are fetched
 *                    as PDFs, at most 10 a poll and a few seconds apart, and their table is read.
 *
 * One item per transaction in a held, watched or tracked stock (an option counts for its
 * underlying; Treasuries, funds and private holdings are skipped). Members have up to 45 days to
 * report a trade, so this is weeks-old context for the dossier: items carry `meta.congress`, which
 * the policy never acts on. Scanned paper filings have no text layer and are skipped. The reports
 * may not be used for commercial purposes (5 U.S.C. §13107(c)); this is a personal paper-trading bot.
 *
 * The files are binary and WireFetch reads text, so this adapter fetches them itself: the wire's
 * User-Agent, a timeout, one attempt, its own pause between PDFs, and a conditional GET for the ZIP.
 */

const HOUSE = "https://disclosures-clerk.house.gov/public_disc"
const zipUrl = (year: number) => `${HOUSE}/financial-pdfs/${year}FD.zip`
const pdfUrl = (f: Filing) => `${HOUSE}/ptr-pdfs/${f.year}/${f.docId}.pdf`

/** Reports filed this many days back are read (the index lists the whole year). */
const WINDOW_DAYS = 14
/** The first poll after boot is a backfill: it reads only the last few days. */
const BACKFILL_DAYS = 3
const MAX_PDFS = 10
const PDF_PAUSE_MS = 4_000
/** A report whose PDF fails this many polls in a row is given up on. */
const MAX_ATTEMPTS = 3
const DONE_MAX = 5_000
const TIMEOUT_MS = 30_000
const MAX_BYTES = 20 * 1024 * 1024

// ── ZIP ─────────────────────────────────────────────────────────────────────

/**
 * The entries of a small ZIP archive, read through its central directory: stored or deflated, no
 * ZIP64, no encryption. `want` picks the entries to inflate (the index ZIP also holds a 0.5 MB XML
 * copy of the list that isn't needed).
 */
export const unzip = (zip: Uint8Array, want: (name: string) => boolean = () => true): Map<string, Buffer> => {
  const buf = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength)
  // The end-of-central-directory record: the last 22 bytes, unless an archive comment follows it.
  let eocd = buf.length - 22
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--
  if (eocd < 0) throw new Error("not a ZIP archive")
  const out = new Map<string, Buffer>()
  let p = buf.readUInt32LE(eocd + 16)
  for (let n = buf.readUInt16LE(eocd + 10); n > 0; n--) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("corrupt ZIP central directory")
    const method = buf.readUInt16LE(p + 10)
    const size = buf.readUInt32LE(p + 20)
    const nameLength = buf.readUInt16LE(p + 28)
    const name = buf.toString("utf8", p + 46, p + 46 + nameLength)
    const local = buf.readUInt32LE(p + 42)
    p += 46 + nameLength + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32)
    if (!want(name)) continue
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`corrupt ZIP entry ${name}`)
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const data = buf.subarray(start, start + size)
    if (method === 0) out.set(name, data)
    else if (method === 8) out.set(name, inflateRawSync(data, { maxOutputLength: MAX_BYTES }))
    else throw new Error(`ZIP entry ${name}: unsupported compression method ${method}`)
  }
  return out
}

// ── Filing index ────────────────────────────────────────────────────────────

/** A row of <year>FD.txt. `filed` is YYYY-MM-DD; `district` is "CA48" (state and seat). */
export type Filing = { docId: string; type: string; year: string; filed: string; first: string; last: string; suffix: string; district: string }

/** <year>FD.txt: tab-separated with a header row (Prefix, Last, First, Suffix, FilingType, StateDst, Year, FilingDate, DocID). */
export const parseFilingIndex = (text: string): Filing[] => {
  // A byte-order mark, if the file starts with one.
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?\n/)
  const head = (lines[0] ?? "").split("\t").map((h) => h.trim())
  const at = { last: "Last", first: "First", suffix: "Suffix", type: "FilingType", district: "StateDst", year: "Year", filed: "FilingDate", docId: "DocID" }
  const col = Object.fromEntries(Object.entries(at).map(([k, name]) => [k, head.indexOf(name)])) as Record<keyof typeof at, number>
  if (Object.values(col).some((i) => i < 0)) throw new Error(`unexpected filing index header: ${head.join(",").slice(0, 120)}`)
  const out: Filing[] = []
  for (const line of lines.slice(1)) {
    const f = line.split("\t").map((s) => s.trim())
    const filed = usDate(f[col.filed])
    const docId = f[col.docId] ?? ""
    if (!filed || !/^\d+$/.test(docId)) continue
    out.push({ docId, type: f[col.type] ?? "", year: f[col.year] || filed.slice(0, 4), filed, first: f[col.first] ?? "", last: f[col.last] ?? "", suffix: f[col.suffix] ?? "", district: f[col.district] ?? "" })
  }
  return out
}

/** The index files to read: this year's, and last year's in the first two weeks of January (late-December reports are still in the window). */
export const indexYears = (day: string) => {
  const year = Number(day.slice(0, 4))
  return day.slice(5) <= "01-14" ? [year - 1, year] : [year]
}

// ── Periodic transaction reports ────────────────────────────────────────────

/** A positioned text run, as pdf.js reports it (PDF coordinates, origin bottom-left). */
export type PdfText = { str: string; x: number; y: number; fontSize: number }

export type Owner = "self" | "spouse" | "joint" | "child"
export type TxType = "purchase" | "sale" | "sale_partial" | "exchange"

export type PtrRow = {
  owner: Owner
  /** "Alphabet Inc. - Class A Common Stock (GOOGL)", without the asset-type code. */
  asset: string
  /** The House's asset-type code: ST stock, OP option, GS government security, MF mutual fund… */
  assetType: string | null
  ticker: string | null
  type: TxType
  tradeDate: string
  notifiedDate: string | null
  /** As filed: "$1,001 - $15,000", "Over $50,000,000", or an exchange's exact value. */
  amount: string
  low: number | null
  high: number | null
  status: string | null
  description: string | null
}

export type Ptr = { name: string | null; district: string | null; rows: PtrRow[] }

const OWNERS: Record<string, Owner> = { SP: "spouse", JT: "joint", DC: "child" }
/** The table header's first line, left to right; each page repeats it. */
const HEADERS = ["Owner", "Asset", "Transaction", "Date", "Notification", "Amount", "Cap."]
/** Column numbers: 0 is the filer's own ID, left of Owner. */
const ASSET = 2
const DATE = 4
const DATE_RE = /^\d{2}\/\d{2}\/\d{4}$/
/** Detail lines under a row ("Filing Status: New", "Subholding Of: …", "Description: …", "Comments: …"), by their initials. */
const DETAILS: Record<string, "status" | "description" | null> = { FS: "status", SO: null, D: "description", C: null }
const FONT_EPS = 0.25

/** The PDF's label font has no lowercase glyphs, so labels arrive as "F\u0000\u0000 S\u0000\u0000: New". */
const clean = (s: string) => s.replace(/\u0000/g, "").replace(/\s+/g, " ").trim()

/** The column starts from a page's header row, and where that row begins in the page's text. */
const tableHeader = (page: PdfText[]) => {
  const from = page.findIndex((t) => clean(t.str) === "Owner")
  if (from < 0) return null
  const y = page[from].y
  const starts = HEADERS.map((h) => page.find((t) => clean(t.str) === h && Math.abs(t.y - y) < 1)?.x)
  return starts.every((x) => x !== undefined) ? { from, starts: starts as number[] } : null
}

/** The value after a "Name:" style label on the cover. */
const field = (page: PdfText[], label: string) => {
  const i = page.findIndex((t) => clean(t.str) === label)
  return i < 0 ? null : (page.slice(i + 1, i + 4).map((t) => clean(t.str)).find(Boolean) ?? null)
}

/** The ticker in parentheses just before the asset-type code ("… Common Stock (GOOGL) [OP]"), class shares as Alpaca writes them (BRK.B). */
export const tickerOf = (asset: string) => {
  const m = /\(([A-Z][A-Z0-9]{0,5}(?:[.\-/][A-Z]{1,2})?)\)\s*\[[A-Z0-9]{2}\]\s*$/.exec(asset)
  return m ? m[1].replace(/[-/]/, ".") : null
}

/** "$1,001 - $15,000" → [1001, 15000]; "Over $50,000,000" → [50000000, null]; "$15.00" → [15, 15]. */
const amountRange = (s: string): [number | null, number | null] => {
  const n = [...s.matchAll(/\$\s?([\d,]+(?:\.\d+)?)/g)].map((m) => Number(m[1].replace(/,/g, "")))
  if (n.length >= 2) return [n[0], n[1]]
  if (n.length === 1) return /over/i.test(s) ? [n[0], null] : [n[0], n[0]]
  return [null, null]
}

const txType = (s: string): TxType | null => (/^P\b/.test(s) ? "purchase" : /^S\b.*partial/i.test(s) ? "sale_partial" : /^S\b/.test(s) ? "sale" : /^E\b/.test(s) ? "exchange" : null)

type Draft = { cells: string[][]; detail: { status?: string; description?: string }; last: "status" | "description" | null; details: boolean }

/**
 * The transactions of an e-filed PTR, from its text runs. Columns come from each page's header
 * (positions shift a little between filings); a row's cells are in the table's font size and its
 * detail lines in a smaller one. A row can break across a page (the rest of its asset name and
 * amount continue under the next page's header), so a new row starts only once the current one
 * has its date and either its asset-type code or its detail lines. The table ends at the
 * asset-type footnote. A scanned report has no text runs and yields no rows.
 */
export const parsePtr = (pages: PdfText[][]): Ptr => {
  const cover = pages[0] ?? []
  const name = field(cover, "Name:")?.replace(/^Hon\.?\s+/, "") ?? null
  const district = field(cover, "State/District:")
  const table: { t: PdfText; starts: number[] }[] = []
  let starts: number[] | null = null
  scan: for (const page of pages) {
    const head = tableHeader(page)
    if (head) starts = head.starts
    if (!starts) continue
    for (const t of page.slice(head?.from ?? 0)) {
      const str = clean(t.str)
      if (str.startsWith("* For the complete list")) break scan
      // The filing ID sits in each page's top margin but comes last in its text.
      if (str && !/^Filing ID #/.test(str)) table.push({ t: { ...t, str }, starts })
    }
  }
  const rowFont = table.find((e) => DATE_RE.test(e.t.str))?.t.fontSize
  if (rowFont === undefined) return { name, district, rows: [] }

  const drafts: Draft[] = []
  let row: Draft | null = null
  for (const { t, starts: xs } of table) {
    // Larger: the header row repeated on each page.
    if (t.fontSize > rowFont + FONT_EPS) continue
    if (t.fontSize < rowFont - FONT_EPS) {
      if (!row) continue
      row.details = true
      const m = /^([A-Z][A-Za-z]*(?: [A-Z][A-Za-z]*)?) ?: ?(.*)$/.exec(t.str)
      const initials = m?.[1].split(" ").map((w) => w[0]).join("") ?? ""
      if (m && initials in DETAILS) {
        row.last = DETAILS[initials]
        if (row.last) row.detail[row.last] = m[2]
      } else if (row.last) row.detail[row.last] += ` ${t.str}`
      continue
    }
    const col = xs.filter((x) => t.x >= x - 3).length
    const complete = row !== null && row.cells[DATE].length > 0 && (row.details || /\[[A-Z0-9]{2}\]$/.test(row.cells[ASSET].join(" ")))
    if (!row || (col <= ASSET && complete)) {
      row = { cells: Array.from({ length: HEADERS.length + 1 }, () => [] as string[]), detail: {}, last: null, details: false }
      drafts.push(row)
    }
    row.cells[col].push(t.str)
  }

  const rows = drafts.flatMap((d): PtrRow[] => {
    const [, owner, asset, type, date, notified, amount] = d.cells.map((c) => c.join(" ").trim())
    const tx = txType(type)
    const tradeDate = usDate(date)
    if (!tx || !tradeDate) return []
    const [low, high] = amountRange(amount)
    return [
      {
        owner: OWNERS[owner] ?? "self",
        asset: asset.replace(/\s*\[[A-Z0-9]{2}\]\s*$/, ""),
        assetType: [...asset.matchAll(/\[([A-Z0-9]{2})\]/g)].at(-1)?.[1] ?? null,
        ticker: tickerOf(asset),
        type: tx,
        tradeDate,
        notifiedDate: usDate(notified),
        amount,
        low,
        high,
        status: d.detail.status ?? null,
        description: d.detail.description ?? null,
      },
    ]
  })
  return { name, district, rows }
}

/** A PDF's text runs, page by page. Throws on a file pdf.js can't open. */
export const pdfText = async (bytes: Uint8Array): Promise<PdfText[][]> => {
  // A copy: pdf.js may take ownership of the buffer it is given.
  const pdf = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 })
  try {
    return (await extractTextItems(pdf)).items
  } finally {
    await pdf.loadingTask.destroy()
  }
}

// ── Items ───────────────────────────────────────────────────────────────────

/** Stocks, and options on them (the item is about the underlying). */
const STOCKS = new Set(["ST", "OP"])
const VERBS: Record<TxType, string> = { purchase: "bought", sale: "sold", sale_partial: "sold", exchange: "exchanged" }
const POLARITY: Record<TxType, -1 | 0 | 1> = { purchase: 1, sale: -1, sale_partial: -1, exchange: 0 }
const OWNER_NOTE: Record<Owner, string> = { self: "", spouse: "spouse; ", joint: "joint; ", child: "dependent child; " }
/** Non-voting seats: the delegates and Puerto Rico's resident commissioner. */
const TERRITORIES = new Set(["AS", "DC", "GU", "MP", "PR", "VI"])

/** "$1K", "$250K", "$5M", "$1.5M", "$15". */
const dollars = (n: number) => (n >= 1e6 ? `$${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${Math.round(n)}`)

const amountText = (low: number | null, high: number | null) =>
  low === null ? "an undisclosed amount" : high === null ? `over ${dollars(low)}` : low === high ? dollars(low) : `${dollars(low)}–${dollars(high)}`

/** "CA48" → "CA-48"; an at-large seat ("WY00") → "WY-AL". */
export const districtLabel = (s: string) => {
  const m = /^([A-Z]{2})(\d{2})$/.exec(s.trim())
  return !m ? s.trim() : m[2] === "00" ? `${m[1]}-AL` : `${m[1]}-${m[2]}`
}

const optionKind = (r: PtrRow) => (r.assetType !== "OP" ? null : /\bputs?\b/i.test(r.description ?? "") ? "put" : /\bcalls?\b/i.test(r.description ?? "") ? "call" : null)

/**
 * A report's transactions in the given symbols. Identical rows (same stock, owner, type and day,
 * e.g. one purchase per brokerage account) are one item with their amounts added up.
 */
export const congressItems = (filing: Filing, ptr: Ptr, symbols: ReadonlySet<string>): RawItem[] => {
  const groups = new Map<string, PtrRow[]>()
  for (const r of ptr.rows) {
    if (!r.ticker || !STOCKS.has(r.assetType ?? "") || !symbols.has(r.ticker)) continue
    const key = [r.ticker, r.owner, r.type, r.tradeDate, r.assetType, optionKind(r)].join("|")
    groups.set(key, [...(groups.get(key) ?? []), r])
  }
  const member = ptr.name || [filing.first, filing.last, filing.suffix].filter(Boolean).join(" ")
  const district = districtLabel(filing.district || ptr.district || "")
  const honorific = TERRITORIES.has(district.slice(0, 2)) ? "Del." : "Rep."
  return [...groups.values()].map((rows): RawItem => {
    const r = rows[0]
    const sum = (k: "low" | "high") => (rows.every((x) => x[k] !== null) ? rows.reduce((s, x) => s + x[k]!, 0) : null)
    const low = sum("low")
    const high = sum("high")
    const option = optionKind(r)
    const what = r.assetType === "OP" ? ` of ${option ? `${option} ` : ""}options` : ""
    const many = rows.length > 1 ? ` in ${rows.length} transactions` : ""
    const partial = r.type === "sale_partial" ? " (partial sale)" : ""
    const polarity = POLARITY[r.type]
    return {
      sourceId: `${filing.docId}:${r.ticker}:${r.owner}:${r.type}:${r.tradeDate}:${r.assetType}${option ? `:${option}` : ""}`,
      title: `${r.ticker}: ${honorific} ${member} (${district}) ${VERBS[r.type]} ${amountText(low, high)}${what}${many}${partial} on ${r.tradeDate} (${OWNER_NOTE[r.owner]}disclosed ${filing.filed})`,
      summary: `${r.asset}${r.description ? `: ${r.description}` : ""}`,
      url: pdfUrl(filing),
      publishedAt: dayStart(filing.filed),
      symbols: [r.ticker!],
      category: "general",
      kind: "filing",
      tier: 3,
      // A put bought is a bet against the stock.
      polarity: option === "put" ? ((-polarity || 0) as -1 | 0 | 1) : polarity,
      // Weeks late and one member's portfolio: dossier context, never loud.
      baseSeverity: 25,
      meta: {
        congress: true,
        member,
        district,
        owner: r.owner,
        transaction: r.type,
        asset_type: r.assetType,
        option,
        amount_range: r.amount,
        amount_low: low,
        amount_high: high,
        transactions: rows.length,
        trade_date: r.tradeDate,
        filed: filing.filed,
        doc_id: filing.docId,
      },
    }
  })
}

// ── Poll ────────────────────────────────────────────────────────────────────

export type BinaryGet = (url: string, headers: Record<string, string>) => Promise<{ status: number; body: Uint8Array; headers: Headers }>

/** One GET of a binary body: a timeout, no retries (the poll loop owns those), non-2xx other than 304 as an HttpError. */
export const binaryGet =
  (userAgent: string): BinaryGet =>
  async (url, headers) => {
    const res = await fetch(url, { headers: { "user-agent": userAgent, ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) })
    const path = new URL(url).pathname
    if (res.status === 304 || !res.ok) {
      await res.body?.cancel()
      if (res.status === 304) return { status: 304, body: new Uint8Array(0), headers: res.headers }
      throw new HttpError(res.status, `GET ${path} failed (${res.status})`, "")
    }
    if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES) {
      await res.body?.cancel()
      throw new Error(`GET ${path}: larger than ${MAX_BYTES} bytes`)
    }
    return { status: res.status, body: new Uint8Array(await res.arrayBuffer()), headers: res.headers }
  }

const daysBefore = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

export const congressPoll = (ctx: SourceContext, { get = binaryGet(ctx.env.SEC_USER_AGENT ?? DEFAULT_USER_AGENT), pauseMs = PDF_PAUSE_MS, maxPdfs = MAX_PDFS }: { get?: BinaryGet; pauseMs?: number; maxPdfs?: number } = {}) => {
  const index = new Map<number, { ptrs: Filing[]; etag: string | null; lastModified: string | null }>()
  /** Reports already read (or given up on) by this process. */
  const done = new Set<string>()
  const failures = new Map<string, number>()
  let first = true

  const finish = (docId: string) => {
    done.add(docId)
    failures.delete(docId)
    if (done.size > DONE_MAX) done.delete(done.values().next().value!)
  }

  /** Re-reads a year's index when it changed; false when it didn't (304, or a new year's file not posted yet). */
  const load = async (year: number, today: string) => {
    const cached = index.get(year)
    const headers: Record<string, string> = { accept: "application/zip" }
    if (cached?.etag) headers["if-none-match"] = cached.etag
    if (cached?.lastModified) headers["if-modified-since"] = cached.lastModified
    let res
    try {
      res = await get(zipUrl(year), headers)
    } catch (error) {
      if (isMissing(error) && today.slice(5, 7) === "01") return false
      throw error
    }
    if (res.status === 304) return false
    const text = [...unzip(res.body, (name) => /FD\.txt$/i.test(name)).values()][0]
    if (!text) throw new Error(`${year}FD.zip has no FD.txt index`)
    index.set(year, { ptrs: parseFilingIndex(text.toString("utf8")).filter((f) => f.type === "P"), etag: res.headers.get("etag"), lastModified: res.headers.get("last-modified") })
    return true
  }

  return async (): Promise<RawItem[] | null> => {
    const today = marketDay(ctx.now())
    let changed = false
    for (const year of indexYears(today)) changed = (await load(year, today)) || changed
    const since = daysBefore(today, WINDOW_DAYS)
    const recent = [...index.values()].flatMap((i) => i.ptrs).filter((f) => f.filed >= since && f.filed <= today && !done.has(f.docId))
    if (first) {
      // Older reports in the window count as read: a later poll would otherwise report them as new.
      const fresh = daysBefore(today, BACKFILL_DAYS)
      for (const f of recent) if (f.filed < fresh) finish(f.docId)
    }
    const pending = recent
      .filter((f) => !done.has(f.docId))
      .sort((a, b) => b.filed.localeCompare(a.filed) || b.docId.localeCompare(a.docId))
      .slice(0, maxPdfs)
    if (!changed && !pending.length) return null

    const symbols = tracked(ctx)
    const items: RawItem[] = []
    let fetched = 0
    let failed: unknown = null
    for (const f of pending) {
      await sleep(pauseMs)
      let body: Uint8Array
      try {
        body = (await get(pdfUrl(f), { accept: "application/pdf" })).body
        fetched += 1
      } catch (error) {
        // Blocked: stop here and let the poll loop slow down.
        if (error instanceof HttpError && (error.status === 403 || error.status === 429)) throw error
        // A 404 is a PDF not posted yet (the index can be ahead of it): retried, but not the source failing.
        if (!(error instanceof HttpError && error.status === 404)) failed = error
        const n = (failures.get(f.docId) ?? 0) + 1
        if (n >= MAX_ATTEMPTS) finish(f.docId)
        else failures.set(f.docId, n)
        ctx.log.debug("congress: PTR fetch failed", { doc: f.docId, attempt: n, error: errorMessage(error) })
        continue
      }
      try {
        items.push(...congressItems(f, parsePtr(await pdfText(body)), symbols))
      } catch (error) {
        ctx.log.debug("congress: unreadable PTR skipped", { doc: f.docId, error: errorMessage(error) })
      }
      finish(f.docId)
    }
    // Every PDF failing (network, 5xx) is the poll failing.
    if (failed && !fetched) throw failed
    first = false
    return items
  }
}

// ── Catalog entry ───────────────────────────────────────────────────────────

export const CONGRESS_SOURCE: SourceSpec = {
  id: "congress:house",
  kind: "custom",
  url: "https://disclosures-clerk.house.gov/FinancialDisclosure",
  interval_s: 6 * 3_600,
  tier: 3,
  wire_kind: "filing",
  default_enabled: true,
  note: "House Clerk periodic transaction reports (official, keyless; daily ZIP index + PDFs, ≤10 a poll): members' trades in held, watched and tracked stocks, weeks late; context only (meta.congress). Personal use: 5 U.S.C. §13107(c) bars commercial use",
  create: (spec, ctx) => new PollingSource(spec, ctx, congressPoll(ctx)),
}
