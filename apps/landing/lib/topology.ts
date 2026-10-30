/**
 * The homepage's animated topology, as data: the runtime chart in the README (its nodes, edges and
 * the Docker stack), laid out twice, wide and tall, and what each bot runs through it: an episode
 * of its agent, woken by code when something matters, that looks things up, decides and trades the
 * paper account. Pure geometry and timing, no React or DOM: components/topology.tsx draws it.
 *
 * Both layouts mirror the bots around what they share: crypto on the left, stock on the right, the
 * stack's shared services down the middle, Browser, Vercel and the database above, the outside world
 * below. Laid out that way no two engine edges cross; the one crossing left (search to the
 * internet, over the stock engine's scraper edge) is drawn as a hop.
 *
 * One departure from the chart: news sources, which it lists with the two paper accounts, get a
 * node of their own under the search engines and article pages. They are where the bots read, not
 * where they trade, so each engine has its own line to them and the paper accounts sit at each
 * bot's side.
 */

export type Bot = "crypto" | "stock"
export const BOTS = ["crypto", "stock"] as const satisfies readonly Bot[]

export type NodeId = "browser" | "dashboards" | "db" | "services" | "news" | "internet" | Bot | "llm" | "search" | "scraper" | "history"

/** What both engines connect to: `crypto & stock --> …` in the chart, plus each one's own state in the database. */
type Shared = "db" | "llm" | "history" | "search" | "scraper" | "services" | "news"

export type EdgeId = "browser-dashboards" | "dashboards-db" | `browser-${Bot}` | `${Bot}-${Shared}` | "search-internet" | "scraper-internet"

/** The chart's edges, caller to callee, with its labels. */
export const EDGES: Record<EdgeId, { from: NodeId; to: NodeId; label?: string }> = {
  "browser-dashboards": { from: "browser", to: "dashboards", label: "HTTPS" },
  "dashboards-db": { from: "dashboards", to: "db", label: "Read data and write commands" },
  "browser-crypto": { from: "browser", to: "crypto", label: "Engine WebSocket stream" },
  "browser-stock": { from: "browser", to: "stock", label: "Engine WebSocket stream" },
  "crypto-db": { from: "crypto", to: "db", label: "Own trading state" },
  "stock-db": { from: "stock", to: "db", label: "Own trading state" },
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
  "crypto-news": { from: "crypto", to: "news" },
  "stock-news": { from: "stock", to: "news" },
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
  /**
   * The Docker stack, and the baseline its name is centered on: on its top edge, which the name
   * breaks like a fieldset's legend (`border`), or just inside it.
   */
  server: Box
  legend: Pt & { border: boolean }
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
    middle: Record<"browser-dashboards" | "dashboards-db" | "search-internet" | "scraper-internet", Spec>
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
  h: 562,
  type: { title: 11.5, detail: 9.5, label: 9 },
  server: { x: 24, y: 178, w: 912, h: 230 },
  legend: { x: 480, y: 181.5, border: true },
  nodes: {
    browser: { x: 420, y: 8, w: 120, h: 30 },
    dashboards: { x: 335, y: 56, w: 290, h: 42 },
    db: { x: 335, y: 116, w: 290, h: 42 },
    crypto: { x: 52, y: 259, w: 180, h: 48 },
    llm: { x: 326, y: 198, w: 308, h: 56 },
    history: { x: 326, y: 262, w: 308, h: 42 },
    search: { x: 326, y: 312, w: 308, h: 42 },
    scraper: { x: 326, y: 362, w: 308, h: 30 },
    internet: { x: 300, y: 426, w: 360, h: 30 },
    news: { x: 300, y: 470, w: 360, h: 30 },
    services: { x: 300, y: 514, w: 360, h: 38 },
  },
  crypto: {
    browser: { pts: [{ x: 420, y: 23 }, { x: 142, y: 23 }, { x: 142, y: 259 }] },
    db: { pts: [{ x: 196, y: 259 }, { x: 196, y: 137 }, { x: 335, y: 137 }] },
    llm: { pts: [{ x: 232, y: 283 }, { x: 296, y: 283 }, { x: 296, y: 226 }, { x: 326, y: 226 }] },
    history: { pts: [{ x: 232, y: 283 }, { x: 326, y: 283 }] },
    search: { pts: [{ x: 232, y: 283 }, { x: 296, y: 283 }, { x: 296, y: 333 }, { x: 326, y: 333 }] },
    scraper: { pts: [{ x: 232, y: 283 }, { x: 296, y: 283 }, { x: 296, y: 377 }, { x: 326, y: 377 }] },
    services: { pts: [{ x: 142, y: 307 }, { x: 142, y: 533 }, { x: 300, y: 533 }] },
    news: { pts: [{ x: 156, y: 307 }, { x: 156, y: 485 }, { x: 300, y: 485 }] },
  },
  middle: {
    "browser-dashboards": { pts: [{ x: 480, y: 38 }, { x: 480, y: 56 }] },
    "dashboards-db": { pts: [{ x: 480, y: 98 }, { x: 480, y: 116 }] },
    "search-internet": { pts: [{ x: 634, y: 343 }, { x: 650, y: 343 }, { x: 650, y: 426 }], hops: [{ x: 650, y: 377, side: 1 }] },
    "scraper-internet": { pts: [{ x: 480, y: 392 }, { x: 480, y: 426 }] },
  },
  labels: [
    { edge: "browser-dashboards", x: 488, y: 50.5, anchor: "start", lines: ["HTTPS"] },
    { edge: "dashboards-db", x: 488, y: 110.5, anchor: "start", lines: ["Read data and write commands"] },
    { edge: "browser-crypto", x: 281, y: 16.5, anchor: "middle", lines: ["Engine WebSocket stream"] },
    { edge: "crypto-db", x: 265, y: 130.5, anchor: "middle", lines: ["Own trading state"] },
  ],
})

/**
 * Phones: the engines side by side at the top of the stack, each running a spine down its own
 * side of the shared column; the browser's stream comes in from the outside edges.
 */
const TALL = mirrored({
  id: "tall",
  w: 380,
  h: 700,
  type: { title: 12, detail: 9.5, label: 8.5 },
  server: { x: 12, y: 200, w: 356, h: 330 },
  legend: { x: 190, y: 219, border: false },
  nodes: {
    browser: { x: 134, y: 8, w: 112, h: 30 },
    dashboards: { x: 100, y: 58, w: 180, h: 52 },
    db: { x: 92, y: 134, w: 196, h: 42 },
    crypto: { x: 24, y: 232, w: 152, h: 50 },
    llm: { x: 66, y: 304, w: 248, h: 70 },
    history: { x: 66, y: 382, w: 248, h: 42 },
    search: { x: 66, y: 432, w: 248, h: 42 },
    scraper: { x: 66, y: 482, w: 248, h: 32 },
    internet: { x: 50, y: 548, w: 280, h: 34 },
    news: { x: 50, y: 596, w: 280, h: 30 },
    services: { x: 50, y: 640, w: 280, h: 50 },
  },
  crypto: {
    browser: { pts: [{ x: 134, y: 23 }, { x: 6, y: 23 }, { x: 6, y: 257 }, { x: 24, y: 257 }] },
    db: { pts: [{ x: 44, y: 232 }, { x: 44, y: 155 }, { x: 92, y: 155 }] },
    llm: { pts: [{ x: 48, y: 282 }, { x: 48, y: 339 }, { x: 66, y: 339 }] },
    history: { pts: [{ x: 48, y: 282 }, { x: 48, y: 403 }, { x: 66, y: 403 }] },
    search: { pts: [{ x: 48, y: 282 }, { x: 48, y: 453 }, { x: 66, y: 453 }] },
    scraper: { pts: [{ x: 48, y: 282 }, { x: 48, y: 498 }, { x: 66, y: 498 }] },
    services: { pts: [{ x: 34, y: 282 }, { x: 34, y: 665 }, { x: 50, y: 665 }] },
    news: { pts: [{ x: 41, y: 282 }, { x: 41, y: 611 }, { x: 50, y: 611 }] },
  },
  middle: {
    "browser-dashboards": { pts: [{ x: 190, y: 38 }, { x: 190, y: 58 }] },
    "dashboards-db": { pts: [{ x: 190, y: 110 }, { x: 190, y: 134 }] },
    "search-internet": { pts: [{ x: 314, y: 463 }, { x: 324, y: 463 }, { x: 324, y: 548 }], hops: [{ x: 324, y: 498 }] },
    "scraper-internet": { pts: [{ x: 190, y: 514 }, { x: 190, y: 548 }] },
  },
  labels: [
    { edge: "browser-dashboards", x: 197, y: 51, anchor: "start", lines: ["HTTPS"] },
    { edge: "dashboards-db", x: 197, y: 120, anchor: "start", lines: ["Read data and", "write commands"] },
    { edge: "browser-crypto", x: 70, y: 16.5, anchor: "middle", lines: ["Engine WebSocket stream"] },
    { edge: "crypto-db", x: 50, y: 190, anchor: "start", lines: ["Own trading state"] },
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
  | "llm:agents"
  | "llm:summaries"
  | "history:bars"
  | "history:archive"
  | "internet:articles"
  | "services:kraken"
  | "services:alpaca"
  | "news:sources"

/** A packet along an edge: forward (caller to callee) or `back`. Minor ones are background traffic. */
export type Hop = { t: number; dur: number; edge: EdgeId; back: boolean; bot: Bot; major: boolean }

export type Cue =
  | { t: number; bot: Bot; kind: "state"; label: string }
  | { t: number; bot: Bot; kind: "lit"; key: HotKey; dur: number }
  | { t: number; bot: Bot; kind: "think"; dur: number }
  | { t: number; bot: Bot; kind: "check" }

/** Seconds per loop. Each bot's agent runs one episode per loop, stock half a loop after crypto. */
export const LOOP = 16
export const OFFSET: Record<Bot, number> = { crypto: 0, stock: LOOP / 2 }

/** The script below is written at a calm pace and played a little faster. */
const PACE = 0.75

/** Where each step (Watch, Look up, Decide) of an episode starts, then where the episode ends, in seconds. */
export const PHASES = [0, 1.5, 5.7, 10.6].map((t) => t * PACE)

/** An engine's status between episodes: the agent sleeps, and code keeps watching. */
export const REST = "Watching"

/** The duration of the intro's wave, played once before the first loop. */
export const INTRO = 1.95

function build() {
  const hops: Hop[] = []
  const cues: Cue[] = []
  for (const bot of BOTS) {
    const at = (t: number) => (OFFSET[bot] + t * PACE) % LOOP
    const go = (t: number, edge: EdgeId, dur: number, back = false) => hops.push({ t: at(t), dur: dur * PACE, edge, back, bot, major: true })
    const say = (t: number, label: string) => cues.push({ t: at(t), bot, kind: "state", label })
    const lit = (t: number, key: HotKey, dur = 1.1) => cues.push({ t: at(t), bot, kind: "lit", key, dur: dur * PACE })
    const think = (t: number, dur: number) => cues.push({ t: at(t), bot, kind: "think", dur: dur * PACE })
    const e = (to: Shared) => `${bot}-${to}` as const
    const account = bot === "crypto" ? "services:kraken" : "services:alpaca"

    // Watch: code in the engine watches everything and wakes the agent when something matters
    // ("The agent" in docs/CRYPTO.md and docs/STOCK.md). Here crypto's wakes for news that a second
    // source confirms, stock's for a setup its screen finds in the minute bars from Alpaca.
    if (bot === "crypto") {
      go(0, e("news"), 0.8, true)
      go(0.2, e("news"), 0.8, true)
      lit(0, "news:sources")
      say(0.8, "Breaking news")
    } else {
      go(0, e("services"), 0.8, true)
      go(0.2, e("services"), 0.8, true)
      lit(0, account)
      say(0.8, "Setup found")
    }

    // Look up: the agent reads its brief on the model, then looks things up a step at a time: a
    // quote, past news or bars in the history store, its past decisions in its own database. The
    // labels follow the Agent page's steps (packages/ui/src/agent.tsx), short enough for the phone
    // layout's engine cards.
    say(1.5, "Agent woke")
    go(1.5, e("llm"), 0.35)
    think(1.85, 0.45)
    lit(1.85, "llm:agents", 5)
    go(2.3, e("llm"), 0.35, true)
    say(2.65, "Looking up")
    go(2.65, e("services"), 0.35)
    go(3, e("services"), 0.35, true)
    go(3.35, e("llm"), 0.3)
    think(3.65, 0.35)
    go(4, e("llm"), 0.3, true)
    go(4.3, e("history"), 0.35)
    lit(4.65, bot === "crypto" ? "history:archive" : "history:bars", 0.9)
    go(4.65, e("history"), 0.35, true)
    go(5, e("db"), 0.35)
    go(5.35, e("db"), 0.35, true)

    // Decide: the agent answers, its limits and the risk engine check the order in code, and it goes
    // to the paper account. The fill is recorded in the database and streamed live, and a dashboard reads it.
    say(5.7, "Agent deciding")
    go(5.7, e("llm"), 0.35)
    think(6.05, 0.8)
    go(6.85, e("llm"), 0.35, true)
    say(7.2, "Risk check")
    cues.push({ t: at(7.2), bot, kind: "check" })
    say(7.6, "Placing order")
    go(7.6, e("services"), 0.5)
    lit(8.1, account)
    go(8.25, e("services"), 0.5, true)
    say(8.75, "Order filled")
    go(8.75, e("db"), 0.5)
    for (const t of [8.75, 8.9, 9.05]) go(t, `browser-${bot}`, 0.7, true)
    go(9.3, "browser-dashboards", 0.35)
    lit(9.65, bot === "crypto" ? "dashboards:crypto" : "dashboards:stock")
    go(9.65, "dashboards-db", 0.3)
    go(9.95, "dashboards-db", 0.3, true)
    go(10.25, "browser-dashboards", 0.35, true)
    say(10.6, REST)
  }

  // Background traffic, the same every loop: live prices and events down each stream, market data
  // from each bot's paper account and news from the sources into each engine. And while the other
  // bot's agent is at work, each news engine fetches an article page through the scraper and has
  // the model summarize it.
  let seed = 7
  const rand = () => {
    seed = (seed * 16807) % 2147483647
    return seed / 2147483647
  }
  for (const bot of BOTS) {
    for (let t = rand() * 1.4; t < LOOP - 1; t += 1.4 + rand() * 1.1) hops.push({ t, dur: 0.9, edge: `browser-${bot}`, back: true, bot, major: false })
    for (let t = 0.6 + rand() * 1.5; t < LOOP - 1; t += 2.1 + rand() * 1.3) hops.push({ t, dur: 0.8, edge: `${bot}-services`, back: true, bot, major: false })
    for (let t = 1.2 + rand() * 2; t < LOOP - 1; t += 2.6 + rand() * 1.6) hops.push({ t, dur: 0.85, edge: `${bot}-news`, back: true, bot, major: false })
    const t0 = (OFFSET[bot] + LOOP / 2 + 1.6) % LOOP
    const bg = (t: number, edge: EdgeId, dur: number, back = false) => hops.push({ t: t0 + t, dur, edge, back, bot, major: false })
    bg(0, `${bot}-scraper`, 0.45)
    bg(0.45, "scraper-internet", 0.4)
    bg(0.85, "scraper-internet", 0.4, true)
    bg(1.25, `${bot}-scraper`, 0.45, true)
    bg(1.7, `${bot}-llm`, 0.4)
    bg(2.7, `${bot}-llm`, 0.4, true)
    cues.push({ t: t0 + 0.85, bot, kind: "lit", key: "internet:articles", dur: 0.8 })
    cues.push({ t: t0 + 2.1, bot, kind: "lit", key: "llm:summaries", dur: 0.8 })
  }
  return { hops: hops.sort((a, b) => a.t - b.t), cues: cues.sort((a, b) => a.t - b.t) }
}

export const TIMELINE = build()

/** Which step of its episode a bot is in at loop time `t`, and how far through it; null between episodes. */
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
