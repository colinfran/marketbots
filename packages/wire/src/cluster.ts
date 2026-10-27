/**
 * Near-duplicate grouping. The same story arrives from many outlets within minutes; the first copy
 * becomes the cluster's root and later copies from other domains become its confirmations (which
 * raise severity and satisfy the entry confirmation rule). An identical syndicated title counts
 * once, whatever domain carries it.
 *
 * Match: title token-set Jaccard ≥ 0.6, within 6 hours, with overlapping symbols (two market-wide
 * items overlap). The index is in memory, bounded to 24 hours, and rebuilt from MongoDB on boot.
 */

export const CLUSTER_JACCARD = 0.6
export const CLUSTER_WINDOW_MS = 6 * 3_600_000
const MEMORY_MS = 24 * 3_600_000

const STOP = new Set(
  "the a an to of in on for and or is are as at by with from after its it be has have had new says said will would over into amid than this that up down out off about more".split(" "),
)

export const titleTokens = (title: string) =>
  new Set(
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}$\s]/gu, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1 && !STOP.has(t))
      // Light stemming: "ETFs" and "ETF", "approves" and "approve" are the same story.
      .map((t) => (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t)),
  )

export const jaccard = (a: ReadonlySet<string>, b: ReadonlySet<string>) => {
  if (!a.size || !b.size) return 0
  let shared = 0
  for (const t of a) if (b.has(t)) shared += 1
  return shared / (a.size + b.size - shared)
}

/** A normalized title for spotting syndicated copies. */
const titleKey = (title: string) => [...titleTokens(title)].join(" ")

export type ClusterEntry = { id: string; tokens: Set<string>; symbols: string[]; at: number; domains: Set<string>; titles: Set<string> }

const overlaps = (a: string[], b: string[]) => (a.length === 0 && b.length === 0) || a.some((s) => b.includes(s))

export class ClusterIndex {
  private entries: ClusterEntry[] = []

  constructor(private readonly max = 20_000) {}

  get size() {
    return this.entries.length
  }

  /** The root of the cluster this title belongs to, or null if it starts a new one. */
  match(title: string, symbols: string[], at: number): ClusterEntry | null {
    const tokens = titleTokens(title)
    let best: ClusterEntry | null = null
    let bestScore = CLUSTER_JACCARD
    for (const e of this.entries) {
      if (Math.abs(at - e.at) > CLUSTER_WINDOW_MS || !overlaps(symbols, e.symbols)) continue
      const score = jaccard(tokens, e.tokens)
      if (score >= bestScore) {
        best = e
        bestScore = score
      }
    }
    return best
  }

  add(id: string, title: string, symbols: string[], at: number, domain: string | null) {
    this.entries.push({ id, tokens: titleTokens(title), symbols, at, domains: new Set(domain ? [domain] : []), titles: new Set([titleKey(title)]) })
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max)
  }

  /**
   * Records a later copy on its root. Returns true when it is an independent confirmation: a
   * domain the cluster hasn't seen, carrying a title that isn't a syndicated duplicate.
   */
  confirm(root: ClusterEntry, title: string, domain: string | null): boolean {
    const key = titleKey(title)
    const independent = !!domain && !root.domains.has(domain) && !root.titles.has(key)
    if (domain) root.domains.add(domain)
    root.titles.add(key)
    return independent
  }

  prune(now: number) {
    const cutoff = now - MEMORY_MS
    if (this.entries.length && this.entries[0].at < cutoff) this.entries = this.entries.filter((e) => e.at >= cutoff)
  }
}
