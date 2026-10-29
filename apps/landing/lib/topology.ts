/**
 * The homepage's animated topology, as data: the runtime chart in the README (its nodes, edges and
 * the Docker stack), laid out twice, wide and tall, and what each bot runs through it: a timed
 * cycle, then an episode of its agent in shadow. Pure geometry and timing, no React or DOM:
 * components/topology.tsx draws it.
 *
 * Both layouts mirror the bots around what they share: crypto on the left, stock on the right, the
 * stack's shared services down the middle, Browser, Vercel and Atlas above, the outside world
 * below. Laid out that way no two engine edges cross; the one crossing left (search to the
 * internet, over the stock engine's scraper edge) is drawn as a hop.
 */

export type Bot = "crypto" | "stock"
export const BOTS = ["crypto", "stock"] as const satisfies readonly Bot[]

export type NodeId = "browser" | "dashboards" | "atlas" | "services" | "internet" | Bot | "llm" | "search" | "scraper" | "history"

/** What both engines connect to: `crypto & stock --> …` in the chart, plus each one's own state in Atlas. */
type Shared = "atlas" | "llm" | "history" | "search" | "scraper" | "services"

export type EdgeId = "browser-dashboards" | "dashboards-atlas" | `browser-${Bot}` | `${Bot}-${Shared}` | "search-internet" | "scraper-internet"

/** The chart's edges, caller to callee, with its labels. */
export const EDGES: Record<EdgeId, { from: NodeId; to: NodeId; label?: string }> = {
  "browser-dashboards": { from: "browser", to: "dashboards", label: "HTTPS" },
  "dashboards-atlas": { from: "dashboards", to: "atlas", label: "Read data and write commands" },
  "browser-crypto": { from: "browser", to: "crypto", label: "Engine WebSocket stream" },
  "browser-stock": { from: "browser", to: "stock", label: "Engine WebSocket stream" },
  "crypto-atlas": { from: "crypto", to: "atlas", label: "Own trading state" },
  "stock-atlas": { from: "stock", to: "atlas", label: "Own trading state" },
  "crypto-llm": { from: "crypto", to: "llm" },
  "stock-llm": { from: "stock", to: "llm" },
  "crypto-history": { from: "crypto", to: "history" },
  "stock-history": { from: "stock", to: "history" },
  "crypto-search": { from: "crypto", to: "search" },
  "stock-search": { from: "stock", to: "search" },
  "crypto-scraper": { from: "crypto", to: "scraper" },
  "stock-scraper": { from: "stock", to: "scraper" },
  "crypto-services": { from: "crypto", to: "services" },
  "stock-services": { from: "stock", to: "services" },
  "search-internet": { from: "search", to: "internet" },
  "scraper-internet": { from: "scraper", to: "internet" },
}

// ── Geometry ────────────────────────────────────────────────────────────────────────────────────

export type Pt = { x: number; y: number }
export type Box = { x: number; y: number; w: number; h: number }

export type Route = {
  /** SVG path data. */
  d: string
  len: number
  /** The point `s` along the route, clamped to its ends. */
  at: (s: number) => Pt
  end: Pt
  /** Unit direction of the last leg: where the arrowhead points. */
  dir: Pt
}

type Seg = { len: number; d: string; at: (u: number) => Pt }

const r2 = (n: number) => Math.round(n * 100) / 100
const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y)
const unit = (a: Pt, b: Pt) => {
  const l = dist(a, b)
  return { x: (b.x - a.x) / l, y: (b.y - a.y) / l }
}

const lineSeg = (a: Pt, b: Pt): Seg => ({
  len: dist(a, b),
  d: `L${r2(b.x)} ${r2(b.y)}`,
  at: (u) => ({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u }),
})

/** An arc around `c` from angle `a0` through `da` (radians; positive is clockwise on screen). */
const arcSeg = (c: Pt, r: number, a0: number, da: number): Seg => {
  const p = (a: number) => ({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) })
  const end = p(a0 + da)
  return { len: Math.abs(da) * r, d: `A${r2(r)} ${r2(r)} 0 0 ${da > 0 ? 1 : 0} ${r2(end.x)} ${r2(end.y)}`, at: (u) => p(a0 + da * u) }
}

/** Radius of a hop, the semicircle where one edge jumps over another. */
const HOP = 5

/**
 * An orthogonal route through `pts`, its corners rounded (radius `r`, shrunk to fit short legs).
 * Each of `hops` that lies on a leg becomes a semicircle there, bulging to `side` (-1: left of a
 * downward leg on screen).
 */
export function route(pts: Pt[], { r = 12, hops = [] }: { r?: number; hops?: (Pt & { side?: 1 | -1 })[] } = {}): Route {
  const last = pts.length - 1
  const radius = pts.map((p, i) => (i === 0 || i === last ? 0 : Math.min(r, dist(pts[i - 1], p) / 2, dist(p, pts[i + 1]) / 2)))
  const segs: Seg[] = []
  let cur = pts[0]
  for (let i = 0; i < last; i++) {
    const u = unit(pts[i], pts[i + 1])
    const legEnd = { x: pts[i + 1].x - u.x * radius[i + 1], y: pts[i + 1].y - u.y * radius[i + 1] }
    const along = hops
      .filter((h) => Math.abs((h.x - cur.x) * u.y - (h.y - cur.y) * u.x) < 0.5)
      .map((h) => ({ h, s: (h.x - cur.x) * u.x + (h.y - cur.y) * u.y }))
      .filter(({ s }) => s > HOP && s < dist(cur, legEnd) - HOP)
      .sort((a, b) => a.s - b.s)
    for (const { h } of along) {
      segs.push(lineSeg(cur, { x: h.x - u.x * HOP, y: h.y - u.y * HOP }))
      segs.push(arcSeg(h, HOP, Math.atan2(-u.y, -u.x), (h.side ?? -1) * Math.PI))
      cur = { x: h.x + u.x * HOP, y: h.y + u.y * HOP }
    }
    segs.push(lineSeg(cur, legEnd))
    cur = legEnd
    if (radius[i + 1] > 0) {
      const v = unit(pts[i + 1], pts[i + 2])
      const c = { x: legEnd.x + v.x * radius[i + 1], y: legEnd.y + v.y * radius[i + 1] }
      const turn = Math.sign(u.x * v.y - u.y * v.x)
      segs.push(arcSeg(c, radius[i + 1], Math.atan2(legEnd.y - c.y, legEnd.x - c.x), (turn * Math.PI) / 2))
      cur = { x: pts[i + 1].x + v.x * radius[i + 1], y: pts[i + 1].y + v.y * radius[i + 1] }
    }
  }
  const starts: number[] = []
  let len = 0
  for (const s of segs) {
    starts.push(len)
    len += s.len
  }
  const at = (s: number) => {
    if (s <= 0) return segs[0].at(0)
    if (s >= len) return segs[segs.length - 1].at(1)
    let i = segs.length - 1
    while (starts[i] > s) i--
    return segs[i].at(segs[i].len ? (s - starts[i]) / segs[i].len : 0)
  }
  return { d: `M${r2(pts[0].x)} ${r2(pts[0].y)}${segs.map((s) => s.d).join("")}`, len, at, end: pts[last], dir: unit(pts[last - 1], pts[last]) }
}

// ── Layouts ─────────────────────────────────────────────────────────────────────────────────────

export type Label = { edge: EdgeId; x: number; y: number; anchor: "start" | "middle" | "end"; lines: string[] }

export type Layout = {
  id: "wide" | "tall"
  w: number
  h: number
  /** Font sizes, in layout units: node titles, node details, edge labels. */
  type: { title: number; detail: number; label: number }
  /** The Docker stack, and where its name sits (centered, just inside the top edge). */
  server: Box
  legend: Pt
  nodes: Record<NodeId, Box>
  routes: Record<EdgeId, Route>
  labels: Label[]
}

type Spec = { pts: Pt[]; hops?: (Pt & { side?: 1 | -1 })[] }

/**
 * A layout from its crypto half: the stock engine, its edges and their labels mirror crypto's
 * across the vertical axis.
 */
function mirrored(
  base: Omit<Layout, "nodes" | "routes" | "labels"> & {
    nodes: Omit<Record<NodeId, Box>, "stock">
    crypto: Record<"browser" | Shared, Spec>
    middle: Record<"browser-dashboards" | "dashboards-atlas" | "search-internet" | "scraper-internet", Spec>
    labels: Label[]
  },
): Layout {
  const { crypto, middle, labels, nodes, ...rest } = base
  const flip = <P extends Pt>(p: P): P => ({ ...p, x: base.w - p.x })
  const routes = {} as Record<EdgeId, Route>
  for (const [to, { pts, hops }] of Object.entries(crypto) as [keyof typeof crypto, Spec][]) {
    const id = (bot: Bot) => (to === "browser" ? `browser-${bot}` : `${bot}-${to}`) as EdgeId
    routes[id("crypto")] = route(pts, { hops })
    routes[id("stock")] = route(pts.map(flip), { hops: hops?.map(flip) })
  }
  for (const [id, { pts, hops }] of Object.entries(middle) as [EdgeId, Spec][]) routes[id] = route(pts, { hops })
  const stockLabels = labels
    .filter((l) => l.edge.startsWith("crypto-") || l.edge === "browser-crypto")
    .map((l): Label => ({ ...flip(l), edge: l.edge.replace("crypto", "stock") as EdgeId, anchor: l.anchor === "start" ? "end" : l.anchor === "end" ? "start" : "middle" }))
  const stock = { ...nodes.crypto, x: base.w - nodes.crypto.x - nodes.crypto.w }
  return { ...rest, nodes: { ...nodes, stock }, routes, labels: [...labels, ...stockLabels] }
}

/** Desktop: the engines flank the shared column, each fanning out to it along its own spine. */
const WIDE = mirrored({
  id: "wide",
  w: 960,
  h: 658,
  type: { title: 12.5, detail: 10, label: 9.5 },
  server: { x: 24, y: 210, w: 912, h: 298 },
  legend: { x: 480, y: 232 },
  nodes: {
    browser: { x: 414, y: 12, w: 132, h: 36 },
    dashboards: { x: 335, y: 70, w: 290, h: 46 },
    atlas: { x: 335, y: 138, w: 290, h: 46 },
    crypto: { x: 52, y: 323, w: 180, h: 64 },
    llm: { x: 352, y: 246, w: 256, h: 74 },
    history: { x: 352, y: 332, w: 256, h: 46 },
    search: { x: 352, y: 390, w: 256, h: 46 },
    scraper: { x: 352, y: 448, w: 256, h: 38 },
    internet: { x: 330, y: 532, w: 300, h: 40 },
    services: { x: 210, y: 598, w: 540, h: 48 },
  },
  crypto: {
    browser: { pts: [{ x: 414, y: 30 }, { x: 142, y: 30 }, { x: 142, y: 323 }] },
    atlas: { pts: [{ x: 196, y: 323 }, { x: 196, y: 161 }, { x: 335, y: 161 }] },
    llm: { pts: [{ x: 232, y: 355 }, { x: 296, y: 355 }, { x: 296, y: 283 }, { x: 352, y: 283 }] },
    history: { pts: [{ x: 232, y: 355 }, { x: 352, y: 355 }] },
    search: { pts: [{ x: 232, y: 355 }, { x: 296, y: 355 }, { x: 296, y: 413 }, { x: 352, y: 413 }] },
    scraper: { pts: [{ x: 232, y: 355 }, { x: 296, y: 355 }, { x: 296, y: 467 }, { x: 352, y: 467 }] },
    services: { pts: [{ x: 142, y: 387 }, { x: 142, y: 622 }, { x: 210, y: 622 }] },
  },
  middle: {
    "browser-dashboards": { pts: [{ x: 480, y: 48 }, { x: 480, y: 70 }] },
    "dashboards-atlas": { pts: [{ x: 480, y: 116 }, { x: 480, y: 138 }] },
    "search-internet": { pts: [{ x: 608, y: 425 }, { x: 624, y: 425 }, { x: 624, y: 532 }], hops: [{ x: 624, y: 467, side: 1 }] },
    "scraper-internet": { pts: [{ x: 480, y: 486 }, { x: 480, y: 532 }] },
  },
  labels: [
    { edge: "browser-dashboards", x: 488, y: 62.5, anchor: "start", lines: ["HTTPS"] },
    { edge: "dashboards-atlas", x: 488, y: 130.5, anchor: "start", lines: ["Read data and write commands"] },
    { edge: "browser-crypto", x: 278, y: 23, anchor: "middle", lines: ["Engine WebSocket stream"] },
    { edge: "crypto-atlas", x: 266, y: 154, anchor: "middle", lines: ["Own trading state"] },
  ],
})

/**
 * Phones: the engines side by side at the top of the stack, each running a spine down its own
 * side of the shared column; the browser's stream comes in from the outside edges.
 */
const TALL = mirrored({
  id: "tall",
  w: 380,
  h: 752,
  type: { title: 12, detail: 9.5, label: 8.5 },
  server: { x: 12, y: 214, w: 356, h: 382 },
  legend: { x: 190, y: 233 },
  nodes: {
    browser: { x: 134, y: 10, w: 112, h: 32 },
    dashboards: { x: 100, y: 64, w: 180, h: 54 },
    atlas: { x: 92, y: 142, w: 196, h: 44 },
    crypto: { x: 24, y: 248, w: 152, h: 56 },
    llm: { x: 66, y: 330, w: 248, h: 78 },
    history: { x: 66, y: 420, w: 248, h: 46 },
    search: { x: 66, y: 478, w: 248, h: 46 },
    scraper: { x: 66, y: 536, w: 248, h: 38 },
    internet: { x: 50, y: 620, w: 280, h: 40 },
    services: { x: 50, y: 686, w: 280, h: 54 },
  },
  crypto: {
    browser: { pts: [{ x: 134, y: 26 }, { x: 6, y: 26 }, { x: 6, y: 276 }, { x: 24, y: 276 }] },
    atlas: { pts: [{ x: 44, y: 248 }, { x: 44, y: 164 }, { x: 92, y: 164 }] },
    llm: { pts: [{ x: 48, y: 304 }, { x: 48, y: 369 }, { x: 66, y: 369 }] },
    history: { pts: [{ x: 48, y: 304 }, { x: 48, y: 443 }, { x: 66, y: 443 }] },
    search: { pts: [{ x: 48, y: 304 }, { x: 48, y: 501 }, { x: 66, y: 501 }] },
    scraper: { pts: [{ x: 48, y: 304 }, { x: 48, y: 555 }, { x: 66, y: 555 }] },
    services: { pts: [{ x: 34, y: 304 }, { x: 34, y: 713 }, { x: 50, y: 713 }] },
  },
  middle: {
    "browser-dashboards": { pts: [{ x: 190, y: 42 }, { x: 190, y: 64 }] },
    "dashboards-atlas": { pts: [{ x: 190, y: 118 }, { x: 190, y: 142 }] },
    "search-internet": { pts: [{ x: 314, y: 511 }, { x: 324, y: 511 }, { x: 324, y: 620 }], hops: [{ x: 324, y: 555 }] },
    "scraper-internet": { pts: [{ x: 190, y: 574 }, { x: 190, y: 620 }] },
  },
  labels: [
    { edge: "browser-dashboards", x: 197, y: 56, anchor: "start", lines: ["HTTPS"] },
    { edge: "dashboards-atlas", x: 197, y: 128, anchor: "start", lines: ["Read data and", "write commands"] },
    { edge: "browser-crypto", x: 70, y: 19, anchor: "middle", lines: ["Engine WebSocket stream"] },
    { edge: "crypto-atlas", x: 50, y: 201, anchor: "start", lines: ["Own trading state"] },
  ],
})

export const LAYOUTS = { wide: WIDE, tall: TALL } as const

/** How far from the browser each edge is, for the intro's wave. */
export const DEPTH: Record<EdgeId, number> = Object.fromEntries(
  (Object.keys(EDGES) as EdgeId[]).map((id) => [id, EDGES[id].from === "browser" ? 0 : id.endsWith("-internet") ? 2 : 1]),
) as Record<EdgeId, number>

// ── Timeline ────────────────────────────────────────────────────────────────────────────────────

/** Words in the nodes that light up while data reaches them. */
export type HotKey =
  | "dashboards:crypto"
  | "dashboards:stock"
  | "llm:research"
  | "llm:decisions"
  | "llm:agents"
  | "llm:summaries"
  | "history:bars"
  | "history:archive"
  | "internet:search"
  | "internet:articles"
  | "services:kraken"
  | "services:alpaca"
  | "services:news"

/**
 * A packet along an edge: forward (caller to callee) or `back`. Minor ones are background traffic;
 * the agent's (`agent`) are drawn as shadows of the cycle's.
 */
export type Hop = { t: number; dur: number; edge: EdgeId; back: boolean; bot: Bot; major: boolean; agent: boolean }

export type Cue =
  | { t: number; bot: Bot; kind: "state"; label: string; agent: boolean }
  | { t: number; bot: Bot; kind: "lit"; key: HotKey; dur: number }
  | { t: number; bot: Bot; kind: "think"; dur: number; agent: boolean }
  | { t: number; bot: Bot; kind: "check" }

/**
 * Seconds per loop. Each bot runs one timed cycle and then one agent episode per loop, stock half a
 * loop after crypto.
 */
export const LOOP = 16
export const OFFSET: Record<Bot, number> = { crypto: 0, stock: LOOP / 2 }

/** The script below is written at a calm pace and played a little faster. */
const PACE = 0.8

/** Where each step (Research, Decide, Publish) of a timed cycle starts, then where the cycle ends, in seconds. */
export const PHASES = [0, 5.4, 9.55, 12.1].map((t) => t * PACE)

/** When the agent's episode starts, just after the cycle, in the script's seconds. */
const EPISODE = 12.4

/** Each engine's own state labels, as its dashboard shows them (apps/<bot>-web/components/kit.tsx). */
const STATES: Record<Bot, { gather: string; decide: string; check: string; order: string; after: string }> = {
  crypto: { gather: "Screening", decide: "AI evaluating", check: "Risk check", order: "Placing order", after: "Monitoring" },
  stock: { gather: "Gathering data", decide: "AI deciding", check: "Executing", order: "Executing", after: "Checking stops" },
}

/** The duration of the intro's wave, played once before the first loop. */
export const INTRO = 1.95

function build() {
  const hops: Hop[] = []
  const cues: Cue[] = []
  for (const bot of BOTS) {
    const at = (t: number) => (OFFSET[bot] + t * PACE) % LOOP
    let agent = false // the cycle's beats first, then the agent's
    const go = (t: number, edge: EdgeId, dur: number, back = false) => hops.push({ t: at(t), dur: dur * PACE, edge, back, bot, major: true, agent })
    const say = (t: number, label: string) => cues.push({ t: at(t), bot, kind: "state", label, agent })
    const lit = (t: number, key: HotKey, dur = 1.1) => cues.push({ t: at(t), bot, kind: "lit", key, dur: dur * PACE })
    const think = (t: number, dur: number) => cues.push({ t: at(t), bot, kind: "think", dur: dur * PACE, agent })
    const s = STATES[bot]
    const e = (to: Shared) => `${bot}-${to}` as const

    // Research: news and prices arrive, the engine reads its bars, searches the web, fetches the
    // article pages, then asks the model to summarize and research.
    say(0, s.gather)
    go(0, e("services"), 0.8, true)
    lit(0, "services:news")
    go(0.3, e("history"), 0.5)
    lit(0.8, "history:bars")
    go(0.85, e("history"), 0.5, true)
    say(1.15, "Researching")
    go(1.15, e("search"), 0.5)
    go(1.65, "search-internet", 0.45)
    lit(2.1, "internet:search")
    go(2.2, "search-internet", 0.45, true)
    go(2.65, e("search"), 0.5, true)
    go(1.35, e("scraper"), 0.5)
    go(1.85, "scraper-internet", 0.45)
    lit(2.3, "internet:articles")
    go(2.4, "scraper-internet", 0.45, true)
    go(2.85, e("scraper"), 0.5, true)
    go(3.4, e("llm"), 0.5)
    think(3.9, 1)
    lit(3.9, "llm:summaries", 1)
    lit(3.9, "llm:research", 1)
    go(4.9, e("llm"), 0.5, true)

    // Decide: the model proposes, deterministic code checks, the order goes to the paper account.
    say(5.4, s.decide)
    go(5.45, e("llm"), 0.5)
    think(5.95, 1.25)
    lit(5.95, "llm:decisions", 1.25)
    go(7.2, e("llm"), 0.5, true)
    say(7.7, s.check)
    cues.push({ t: at(7.7), bot, kind: "check" })
    say(8.15, s.order)
    go(8.15, e("services"), 0.6)
    lit(8.75, bot === "crypto" ? "services:kraken" : "services:alpaca")
    go(8.95, e("services"), 0.6, true)

    // Publish: state to Atlas, bars and news to the history store, events down the stream, and a
    // dashboard reading Atlas.
    say(9.55, s.after)
    go(9.55, e("atlas"), 0.65)
    go(9.6, e("history"), 0.55)
    lit(10.15, "history:archive")
    for (const t of [9.6, 9.78, 9.96]) go(t, `browser-${bot}`, 0.85, true)
    go(10.5, "browser-dashboards", 0.4)
    lit(10.9, bot === "crypto" ? "dashboards:crypto" : "dashboards:stock")
    go(10.9, "dashboards-atlas", 0.35)
    go(11.3, "dashboards-atlas", 0.35, true)
    go(11.65, "browser-dashboards", 0.4, true)
    say(12.1, "Idle")

    // The agent, in shadow ("The agent (shadow)" in docs/CRYPTO.md and docs/STOCK.md): news wakes
    // it; it reads its brief on the model, looks up past news in the history store and past
    // decisions in its own database, then decides. Its answer passes the envelope and the risk
    // checks and fills in the shadow book (in Atlas, never at the broker) while the Agent page
    // streams the episode. The labels follow the Agent page's steps (packages/ui/src/agent.tsx),
    // short enough for the phone layout's engine cards.
    const E = EPISODE
    go(E, e("services"), 0.7, true)
    lit(E, "services:news")
    agent = true
    say(E + 0.7, "Agent woke")
    lit(E + 1.1, "llm:agents", 4.4)
    go(E + 0.75, e("llm"), 0.35)
    think(E + 1.1, 0.4)
    go(E + 1.5, e("llm"), 0.35, true)
    say(E + 1.85, "Looking up")
    go(E + 1.85, e("history"), 0.35)
    lit(E + 2.2, "history:archive", 0.9)
    go(E + 2.2, e("history"), 0.35, true)
    go(E + 2.55, e("llm"), 0.35)
    think(E + 2.9, 0.4)
    go(E + 3.3, e("llm"), 0.35, true)
    go(E + 3.65, e("atlas"), 0.4)
    go(E + 4.05, e("atlas"), 0.4, true)
    say(E + 4.45, "Agent deciding")
    go(E + 4.45, e("llm"), 0.35)
    think(E + 4.8, 0.7)
    go(E + 5.5, e("llm"), 0.35, true)
    say(E + 5.85, "Shadow fill")
    cues.push({ t: at(E + 5.85), bot, kind: "check" })
    go(E + 6.15, e("atlas"), 0.55)
    for (const t of [6.15, 6.33]) go(E + t, `browser-${bot}`, 0.8, true)
    say(E + 6.95, "Idle")
  }

  // Background traffic, the same every loop: live prices and events down each stream, news and
  // market data into each engine.
  let seed = 7
  const rand = () => {
    seed = (seed * 16807) % 2147483647
    return seed / 2147483647
  }
  for (const bot of BOTS) {
    for (let t = rand() * 1.4; t < LOOP - 1; t += 1.4 + rand() * 1.1) hops.push({ t, dur: 0.9, edge: `browser-${bot}`, back: true, bot, major: false, agent: false })
    for (let t = 0.6 + rand() * 1.5; t < LOOP - 1; t += 2.1 + rand() * 1.3) hops.push({ t, dur: 0.8, edge: `${bot}-services`, back: true, bot, major: false, agent: false })
  }
  return { hops: hops.sort((a, b) => a.t - b.t), cues: cues.sort((a, b) => a.t - b.t) }
}

export const TIMELINE = build()

/** Which step of its timed cycle a bot is in at loop time `t`, and how far through it; null outside the cycle. */
export function phaseAt(bot: Bot, t: number): { step: number; p: number } | null {
  const rel = (t - OFFSET[bot] + LOOP) % LOOP
  for (let i = 0; i < 3; i++) if (rel < PHASES[i + 1]) return { step: i, p: (rel - PHASES[i]) / (PHASES[i + 1] - PHASES[i]) }
  return null
}

/** A bot's engine state at loop time `t`: its latest state cue, wrapping from the previous loop. */
export function stateAt(bot: Bot, t: number): Extract<Cue, { kind: "state" }> {
  const states = TIMELINE.cues.filter((c): c is Extract<Cue, { kind: "state" }> => c.kind === "state" && c.bot === bot)
  return states.findLast((c) => c.t <= t) ?? states[states.length - 1]
}
