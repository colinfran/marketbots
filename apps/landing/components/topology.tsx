"use client"

import { Button } from "@mb/ui/components/button"
import { cn } from "cn"
import {
  AppWindowIcon,
  DatabaseIcon,
  GlobeIcon,
  HistoryIcon,
  LandmarkIcon,
  LayoutDashboardIcon,
  type LucideIcon,
  NewspaperIcon,
  PauseIcon,
  PlayIcon,
  RadioIcon,
  ScanTextIcon,
  SearchIcon,
  ShieldCheckIcon,
  SparklesIcon,
  WalletIcon,
} from "lucide-react"
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react"
import { CryptoMark, StockMark } from "@/components/marks"
import {
  type Bot,
  BOTS,
  type Box,
  type Cue,
  DEPTH,
  EDGES,
  type EdgeId,
  type HotKey,
  type Hop,
  INTRO,
  LAYOUTS,
  type Layout,
  LOOP,
  type NodeId,
  OFFSET,
  phaseAt,
  type Pt,
  route,
  type Route,
  stateAt,
  TIMELINE,
} from "@/lib/topology"

/**
 * The runtime chart from the README, live: each bot runs its timed cycle through the stack, then
 * its agent runs an episode in shadow, drawn as a shadow of the cycle's traffic. The diagram is SVG
 * (crisp, themed by the CSS tokens, rendered on the server); the packets, glows and meters are
 * drawn on a canvas over it. Pauses off screen, starts paused for reduced motion, and has a pause
 * button.
 */

// ── Content ─────────────────────────────────────────────────────────────────────────────────────

type Span = string | { text: string; hot: HotKey }
type Row = { title?: boolean; spans: Span[] }

const title = (...spans: Span[]): Row => ({ title: true, spans })
const detail = (...spans: Span[]): Row => ({ spans })
const hot = (text: string, key: HotKey): Span => ({ text, hot: key })

/** Each node's text, from the chart. Hot words light up while data reaches them. */
const NODES: Record<Exclude<NodeId, Bot | "services">, { Icon: LucideIcon; rows: Row[]; tall?: Row[] }> = {
  browser: { Icon: AppWindowIcon, rows: [title("Browser")] },
  dashboards: {
    Icon: LayoutDashboardIcon,
    rows: [title("Vercel dashboards"), detail(hot("cryptomarketbot.app", "dashboards:crypto"), " · ", hot("stockmarketbot.app", "dashboards:stock"))],
    tall: [title("Vercel dashboards"), detail(hot("cryptomarketbot.app", "dashboards:crypto")), detail(hot("stockmarketbot.app", "dashboards:stock"))],
  },
  atlas: { Icon: DatabaseIcon, rows: [title("MongoDB Atlas"), detail("separate database per bot")] },
  llm: {
    Icon: SparklesIcon,
    rows: [
      title("Local LLM"),
      detail("Qwen 3.6 on two GPUs"),
      detail(hot("research", "llm:research"), ", ", hot("decisions", "llm:decisions"), ","),
      detail(hot("the agents", "llm:agents"), ", ", hot("summaries", "llm:summaries")),
    ],
  },
  history: { Icon: HistoryIcon, rows: [title("History store"), detail(hot("price bars", "history:bars"), " and ", hot("news archive", "history:archive"))] },
  search: { Icon: SearchIcon, rows: [title("Web search"), detail("SearXNG")] },
  scraper: { Icon: ScanTextIcon, rows: [title("Shared scraper")] },
  internet: { Icon: GlobeIcon, rows: [title(hot("Search engines", "internet:search"), " and ", hot("article pages", "internet:articles"))] },
}

/** The services node, one segment each: crypto's account on its side, stock's on the other. */
const SERVICES: { key: HotKey; Icon: LucideIcon; wide: string; tall: [string, string] }[] = [
  { key: "services:kraken", Icon: WalletIcon, wide: "Kraken paper wallet", tall: ["Kraken", "paper wallet"] },
  { key: "services:news", Icon: NewspaperIcon, wide: "News sources", tall: ["News", "sources"] },
  { key: "services:alpaca", Icon: LandmarkIcon, wide: "Alpaca paper account", tall: ["Alpaca", "paper account"] },
]

const ENGINES: Record<Bot, { name: string; Mark: typeof CryptoMark; tone: string }> = {
  crypto: { name: "Crypto engine", Mark: CryptoMark, tone: "text-bot-crypto" },
  stock: { name: "Stock engine", Mark: StockMark, tone: "text-bot-stock" },
}

/** The loop both bots run, one line each. */
const STEPS = [
  { Icon: NewspaperIcon, title: "Research", text: "about 150 news sources and live market data" },
  { Icon: ShieldCheckIcon, title: "Decide", text: "the AI proposes, a risk engine checks every order" },
  { Icon: RadioIcon, title: "Publish", text: "every decision and trade streams live" },
]

/** Names for the screen-reader version of the chart. */
const NAMES: Record<NodeId, string> = {
  browser: "Browser",
  dashboards: "Vercel dashboards",
  atlas: "MongoDB Atlas, a separate database per bot",
  services: "the Kraken paper wallet, the Alpaca paper account and news sources",
  internet: "search engines and article pages",
  crypto: "Crypto engine",
  stock: "Stock engine",
  llm: "Local LLM, Qwen 3.6 on two GPUs, for research, decisions, the agents and summaries",
  search: "Web search, SearXNG",
  scraper: "Shared scraper",
  history: "History store, price bars and news archive",
}

const NEIGHBOURS = (() => {
  const map = new Map<NodeId, Set<NodeId>>()
  for (const { from, to } of Object.values(EDGES)) {
    map.set(from, (map.get(from) ?? new Set()).add(to))
    map.set(to, (map.get(to) ?? new Set()).add(from))
  }
  return map
})()

// ── Geometry shared by the SVG and the canvas ───────────────────────────────────────────────────

/** Baselines of a node's rows, the block centered vertically in its box. */
function baselines(box: Box, rows: { title?: boolean }[], type: Layout["type"]) {
  const lead = (r: { title?: boolean }) => (r.title ? type.title * 1.32 : type.detail * 1.5)
  let y = box.y + (box.h - rows.reduce((sum, r) => sum + lead(r), 0)) / 2
  return rows.map((r) => {
    const base = y + lead(r) / 2 + (r.title ? type.title : type.detail) * 0.34
    y += lead(r)
    return base
  })
}

/** An engine card's status dot. */
const statusDot = (box: Box, type: Layout["type"]): Pt => ({ x: box.x + 39.5, y: baselines(box, [{ title: true }, {}], type)[1] - type.detail * 0.34 })

/** The local model's two GPU meters, at its right edge. */
const gpuMeters = (box: Box) => [0, 1].map((i) => ({ x: box.x + box.w - 24 + i * 7, y: box.y + 13, w: 4, h: box.h - 26 }))

/** The model's outline as a route, for the comet that runs around it while it thinks. */
const outline = (b: Box) =>
  route(
    [
      { x: b.x + b.w / 2, y: b.y },
      { x: b.x + b.w, y: b.y },
      { x: b.x + b.w, y: b.y + b.h },
      { x: b.x, y: b.y + b.h },
      { x: b.x, y: b.y },
      { x: b.x + b.w / 2, y: b.y },
    ],
    { r: 8 },
  )
const OUTLINES = { wide: outline(LAYOUTS.wide.nodes.llm), tall: outline(LAYOUTS.tall.nodes.llm) }

// ── The diagram ─────────────────────────────────────────────────────────────────────────────────

const EDGE_STROKE = "stroke-[color-mix(in_oklab,var(--foreground)_24%,var(--background))]"
const NODE_STROKE = "stroke-[color-mix(in_oklab,var(--foreground)_13%,var(--background))]"
const DIM = "transition-opacity duration-300 data-[dim=true]:opacity-20"

function Rows({ box, rows, type, Icon, x = box.x + 34 }: { box: Box; rows: Row[]; type: Layout["type"]; Icon?: LucideIcon; x?: number }) {
  const ys = baselines(box, rows, type)
  return (
    <>
      {Icon && <Icon x={box.x + 12} y={ys[0] - type.title * 0.36 - 7} width={14} height={14} strokeWidth={1.75} className="text-muted-foreground" />}
      {rows.map((row, i) => (
        <text
          key={i}
          x={x}
          y={ys[i]}
          fontSize={row.title ? type.title : type.detail}
          className={row.title ? "fill-foreground font-sans font-medium" : "fill-muted-foreground font-mono"}
        >
          {row.spans.map((s, j) =>
            typeof s === "string" ? (
              s
            ) : (
              <tspan key={j} data-hot={s.hot} className={row.title ? undefined : "transition-[fill] duration-300 data-[on=true]:fill-foreground"}>
                {s.text}
              </tspan>
            ),
          )}
        </text>
      ))}
    </>
  )
}

function NodeCard({ box, id, layout, dim, strong, children }: { box: Box; id: NodeId; layout: Layout["id"]; dim: boolean; strong?: boolean; children: React.ReactNode }) {
  return (
    <g data-node={id} data-dim={dim} className={DIM}>
      <rect
        x={box.x}
        y={box.y}
        width={box.w}
        height={box.h}
        rx={8}
        filter={`url(#topology-lift-${layout})`}
        className={cn("fill-card", strong ? "stroke-[color-mix(in_oklab,var(--foreground)_22%,var(--background))]" : NODE_STROKE)}
      />
      {children}
    </g>
  )
}

function Diagram({ layout, hover, onHover, className }: { layout: Layout; hover: NodeId | null; onHover: (id: NodeId | null) => void; className?: string }) {
  const { id, w, h, type, nodes, routes, labels, server, legend } = layout
  const near = hover ? NEIGHBOURS.get(hover) : undefined
  const dimNode = (n: NodeId) => !!hover && n !== hover && !near?.has(n)
  const dimEdge = (e: EdgeId) => !!hover && EDGES[e].from !== hover && EDGES[e].to !== hover

  return (
    <div className={cn("relative", className)} style={{ aspectRatio: `${w} / ${h}` }}>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        data-layout={id}
        aria-hidden
        className="absolute inset-0 size-full overflow-visible select-none"
        onPointerOver={(e) => {
          if (e.pointerType === "mouse") onHover(((e.target as Element).closest("[data-node]")?.getAttribute("data-node") as NodeId) ?? null)
        }}
        onPointerLeave={() => onHover(null)}
      >
        <defs>
          <filter id={`topology-lift-${id}`} x="-10%" y="-20%" width="120%" height="150%">
            <feDropShadow dx="0" dy="1" stdDeviation="1.5" floodColor="#000" floodOpacity="0.06" />
          </filter>
        </defs>

        {/* The Docker stack */}
        <rect x={server.x} y={server.y} width={server.w} height={server.h} rx={14} strokeDasharray="4 4" className="fill-foreground/[0.025] stroke-foreground/20" />
        <text x={legend.x} y={legend.y} textAnchor="middle" fontSize={type.label + 0.5} className="fill-muted-foreground font-mono">
          <tspan className="fill-foreground">marketbots</tspan> Docker stack, on the owner&apos;s server
        </text>

        {/* Edges, with an arrowhead where the caller reaches the callee */}
        {(Object.entries(routes) as [EdgeId, Route][]).map(([edge, r]) => {
          const n = { x: -r.dir.y, y: r.dir.x }
          const back = { x: r.end.x - r.dir.x * 5, y: r.end.y - r.dir.y * 5 }
          return (
            <g key={edge} data-dim={dimEdge(edge)} className={cn(DIM, EDGE_STROKE)} fill="none" strokeWidth={1.1} strokeLinecap="round" strokeLinejoin="round">
              <path d={r.d} />
              <path d={`M${back.x + n.x * 3.6} ${back.y + n.y * 3.6}L${r.end.x} ${r.end.y}L${back.x - n.x * 3.6} ${back.y - n.y * 3.6}`} />
            </g>
          )
        })}
        {labels.map((l) => (
          <text key={`${l.edge}-${l.x}`} x={l.x} y={l.y} textAnchor={l.anchor} fontSize={type.label} data-dim={dimEdge(l.edge)} className={cn(DIM, "fill-muted-foreground font-mono")}>
            {l.lines.map((line, i) => (
              <tspan key={i} x={l.x} dy={i ? type.label * 1.25 : 0}>
                {line}
              </tspan>
            ))}
          </text>
        ))}

        {/* Nodes */}
        {(Object.keys(NODES) as (keyof typeof NODES)[]).map((n) => (
          <NodeCard key={n} id={n} layout={id} box={nodes[n]} dim={dimNode(n)}>
            <Rows box={nodes[n]} rows={(id === "tall" && NODES[n].tall) || NODES[n].rows} type={type} Icon={NODES[n].Icon} />
            {n === "llm" &&
              gpuMeters(nodes.llm).map((m, i) => <rect key={i} x={m.x} y={m.y} width={m.w} height={m.h} rx={2} className="fill-muted" />)}
          </NodeCard>
        ))}

        <NodeCard id="services" layout={id} box={nodes.services} dim={dimNode("services")}>
          {SERVICES.map((s, i) => {
            const b = nodes.services
            const seg = { x: b.x + (b.w / 3) * i, y: b.y, w: b.w / 3, h: b.h }
            return (
              <g key={s.key}>
                {i > 0 && <path d={`M${seg.x} ${seg.y + 10}V${seg.y + seg.h - 10}`} className={NODE_STROKE} />}
                {id === "wide" ? (
                  <Rows box={seg} rows={[title(hot(s.wide, s.key))]} type={type} Icon={s.Icon} />
                ) : (
                  <g textAnchor="middle">
                    <Rows box={seg} rows={[title(hot(s.tall[0], s.key)), detail(s.tall[1])]} type={type} x={seg.x + seg.w / 2} />
                  </g>
                )}
              </g>
            )
          })}
        </NodeCard>

        {BOTS.map((bot) => {
          const b = nodes[bot]
          const { name, Mark, tone } = ENGINES[bot]
          const [nameY, statusY] = baselines(b, [{ title: true }, {}], type)
          const dot = statusDot(b, type)
          return (
            <NodeCard key={bot} id={bot} layout={id} box={b} dim={dimNode(bot)} strong>
              <g transform={`translate(${b.x + 12} ${nameY - type.title * 0.36 - 8})`} className={tone}>
                <Mark size={16} />
              </g>
              <text x={b.x + 34} y={nameY} fontSize={type.title} className="fill-foreground font-sans font-medium">
                {name}
              </text>
              <circle
                data-dot={bot}
                cx={dot.x}
                cy={dot.y}
                r={2.75}
                strokeWidth={1.3}
                className={cn(
                  "fill-muted-foreground/40 transition-[fill] duration-300 data-[on=agent]:fill-card",
                  bot === "crypto" ? "data-[on=agent]:stroke-bot-crypto data-[on=true]:fill-bot-crypto" : "data-[on=agent]:stroke-bot-stock data-[on=true]:fill-bot-stock",
                )}
              />
              <text data-status={bot} x={b.x + 46.5} y={statusY} fontSize={type.detail} className="fill-muted-foreground font-mono transition-[fill] duration-300 data-[on=agent]:fill-foreground data-[on=true]:fill-foreground">
                Idle
              </text>
              <ShieldCheckIcon
                data-check={bot}
                x={b.x + b.w - 26}
                y={b.y + (b.h - 14) / 2}
                width={14}
                height={14}
                strokeWidth={1.75}
                className="text-foreground opacity-0 transition-opacity duration-300 data-[on=true]:opacity-100"
              />
            </NodeCard>
          )
        })}
      </svg>
      <canvas data-layout={id} aria-hidden className="pointer-events-none absolute inset-0 size-full" />
    </div>
  )
}

/** The three steps, each with a track the bots move along as their cycles run. */
function Steps() {
  return (
    <ol className="grid gap-x-6 gap-y-4 border-t px-4 py-4 sm:grid-cols-3">
      {STEPS.map(({ Icon, title, text }, i) => (
        <li key={title} data-step={i} className="group">
          <div className="bg-border relative mb-3 h-px">
            {BOTS.map((bot) => (
              <span key={bot} data-pip={`${bot}-${i}`} className="absolute top-0 left-0 opacity-0 transition-opacity duration-300">
                <span className={cn("absolute top-0 right-0 h-px w-10 bg-linear-to-r from-transparent", bot === "crypto" ? "to-bot-crypto" : "to-bot-stock")} />
                <span className={cn("ring-background absolute top-0 left-0 size-1.5 -translate-1/2 rounded-full ring-2", bot === "crypto" ? "bg-bot-crypto" : "bg-bot-stock")} />
              </span>
            ))}
          </div>
          <p className="text-muted-foreground flex items-start gap-2 text-sm">
            <Icon className="group-data-[active=true]:text-foreground mt-0.5 size-4 shrink-0 transition-colors duration-300" aria-hidden />
            <span>
              <span className="text-foreground font-medium">{title}:</span> {text}
            </span>
          </p>
        </li>
      ))}
    </ol>
  )
}

const REDUCED = "(prefers-reduced-motion: reduce)"
const onReducedMotion = (onChange: () => void) => {
  const query = matchMedia(REDUCED)
  query.addEventListener("change", onChange)
  return () => query.removeEventListener("change", onChange)
}

export function Topology() {
  const root = useRef<HTMLElement>(null)
  const titleId = useId()
  const reduced = useSyncExternalStore(onReducedMotion, () => matchMedia(REDUCED).matches, () => false)
  // The viewer's play/pause wins; until they choose, reduced motion decides.
  const [choice, setChoice] = useState<boolean | null>(null)
  const playing = choice ?? !reduced
  const [hover, setHover] = useState<NodeId | null>(null)
  const live = useRef({ playing, hover })
  const player = useRef<ReturnType<typeof animate>>(null)

  useEffect(() => {
    const p = animate(root.current!, live.current)
    player.current = p
    return p.dispose
  }, [])
  useEffect(() => {
    live.current.playing = playing
    live.current.hover = hover
    player.current?.kick()
  }, [playing, hover])

  return (
    <section ref={root} aria-labelledby={titleId} className="overflow-hidden rounded-xl border">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b py-1.5 pr-2 pl-4">
        <h2 id={titleId} className="text-muted-foreground font-mono text-xs tracking-wide uppercase">
          How they work
        </h2>
        {/* On phones the legend takes its own row, under the title and the pause button. */}
        <ul aria-label="Legend" className="text-muted-foreground order-last flex basis-full flex-wrap gap-x-3 gap-y-1 pb-1.5 text-xs md:order-none md:basis-auto md:pb-0">
          {BOTS.map((bot) => {
            const { Mark, tone } = ENGINES[bot]
            return (
              <li key={bot} className="flex items-center gap-1.5">
                <Mark className={cn("size-3.5", tone)} />
                {bot === "crypto" ? "CryptoMarketBot" : "StockMarketBot"}
              </li>
            )
          })}
          <li className="flex items-center gap-1.5">
            {/* The agent's packets as the canvas draws them: a dashed trail, a hollow head. */}
            <svg viewBox="0 0 22 8" className="h-2 w-[22px]" aria-hidden>
              <path d="M1 4h11" strokeDasharray="2.5 2" className="stroke-current" />
              <circle cx={16.5} cy={4} r={2.6} strokeWidth={1.3} className="fill-none stroke-current" />
            </svg>
            Agent, in shadow
          </li>
        </ul>
        <Button variant="ghost" size="icon-sm" className="ml-auto" aria-label={playing ? "Pause the animation" : "Play the animation"} onClick={() => setChoice(!playing)}>
          {playing ? <PauseIcon /> : <PlayIcon />}
        </Button>
      </header>
      <div className="@container relative px-4 py-5">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 [background-image:radial-gradient(color-mix(in_oklab,var(--foreground)_14%,transparent)_1px,transparent_1px)] [background-size:16px_16px] [mask-image:radial-gradient(ellipse_at_center,black_35%,transparent_80%)]"
        />
        <Diagram layout={LAYOUTS.wide} hover={hover} onHover={setHover} className="hidden @min-[840px]:block" />
        <Diagram layout={LAYOUTS.tall} hover={hover} onHover={setHover} className="mx-auto max-w-[440px] @min-[840px]:hidden" />
      </div>
      <Steps />
      <div className="sr-only">
        <p>
          The marketbots Docker stack, on the owner&apos;s server, runs the crypto engine, the stock engine, the local LLM, web search, the shared scraper and the
          history store. Its connections:
        </p>
        <ul>
          {(Object.keys(EDGES) as EdgeId[]).map((e) => (
            <li key={e}>
              {NAMES[EDGES[e].from]} to {NAMES[EDGES[e].to]}
              {EDGES[e].label && `: ${EDGES[e].label}`}
            </li>
          ))}
        </ul>
        <p>
          Beside its timed cycles, each engine runs an agent in shadow: woken when something matters, it looks things up on the local model, in the history store and
          in its own database, then decides. Its decisions fill a simulated shadow book in Atlas; nothing it decides reaches the broker.
        </p>
      </div>
    </section>
  )
}

// ── The animation ───────────────────────────────────────────────────────────────────────────────

type RGB = [number, number, number]
type Tone = Bot | "ink"
/**
 * An arrival: a ring around the node reached, or a ripple at the port it came in by (`end`: the
 * callee's end). The agent's are dashed, like its packets.
 */
type Effect = { t0: number; tone: Tone; major: boolean; agent: boolean } & ({ kind: "ring"; node: NodeId } | { kind: "burst"; edge: EdgeId; end: boolean })

const hex = (value: string): RGB => {
  const n = parseInt(value.trim().replace("#", ""), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
const rgba = ([r, g, b]: RGB, a: number) => `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a))})`
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
const clamp01 = (u: number) => Math.max(0, Math.min(1, u))
const sine = (u: number) => 0.5 - Math.cos(Math.PI * clamp01(u)) / 2
const easeOut = (u: number) => 1 - (1 - clamp01(u)) ** 3
/** a < t <= b on the loop, wrapping. */
const crossed = (t: number, a: number, b: number) => (a <= b ? t > a && t <= b : t > a || t <= b)
/**
 * Whether a bot's first cycle has begun by `T` seconds into the loops. Stock's starts half a loop
 * in, so the first loop opens with crypto alone instead of stock caught mid-cycle.
 */
const started = (bot: Bot, T: number) => T >= OFFSET[bot] - 1e-3

/** Seconds of travel a packet's tail trails behind it. */
const TAIL = 0.16
const THINKS = TIMELINE.cues.filter((c): c is Extract<Cue, { kind: "think" }> => c.kind === "think")

/**
 * Runs the animation in `root`: a clock that advances while playing and on screen, the cues it
 * crosses (engine states, lit words, risk checks), and a canvas frame per tick for the visible
 * layout. `live` is read every frame; call `kick` after changing it.
 */
function animate(root: HTMLElement, live: { playing: boolean; hover: NodeId | null }) {
  const canvases = [...root.querySelectorAll<HTMLCanvasElement>("canvas[data-layout]")]
  const pips = BOTS.map((bot) => [0, 1, 2].map((i) => root.querySelector<HTMLElement>(`[data-pip="${bot}-${i}"]`)))
  const steps = [0, 1, 2].map((i) => root.querySelector<HTMLElement>(`[data-step="${i}"]`))
  const read = () => {
    const css = getComputedStyle(root)
    return { crypto: hex(css.getPropertyValue("--bot-crypto")), stock: hex(css.getPropertyValue("--bot-stock")), ink: hex(css.getPropertyValue("--chart-ink")), dark: document.documentElement.classList.contains("dark") }
  }
  let colors = read()
  let visible = false
  let raf = 0
  let last = 0
  let clock = 0 // seconds played, the intro included
  let prevClock = 0
  let prev: number | null = null // the loop time last frame, null until the loop starts
  let effects: Effect[] = []
  const lit = new Map<HotKey, { bot: Bot; t0: number; dur: number }>()
  const checks = new Map<Bot, number>()
  const busy: Record<Bot, boolean> = { crypto: false, stock: false }
  const agentAtWork: Record<Bot, boolean> = { crypto: false, stock: false }
  let words: Partial<Record<Layout["id"], Map<HotKey, Pt & { w: number }>>> = {}

  const each = (selector: string, fn: (el: Element) => void) => root.querySelectorAll(selector).forEach(fn)
  const setHot = (key: HotKey, on: boolean) => each(`[data-hot="${key}"]`, (el) => el.setAttribute("data-on", String(on)))
  /** An engine's status line: the cycle's state, or the agent's (its dot hollow) while an episode runs. */
  const setState = (bot: Bot, label: string, agent = false) => {
    busy[bot] = label !== "Idle"
    agentAtWork[bot] = busy[bot] && agent
    const on = agentAtWork[bot] ? "agent" : String(busy[bot])
    each(`[data-status="${bot}"]`, (el) => {
      if (el.firstChild) el.firstChild.nodeValue = label
      el.setAttribute("data-on", on)
    })
    each(`[data-dot="${bot}"]`, (el) => el.setAttribute("data-on", on))
  }
  const color = (tone: Tone) => colors[tone]

  /** Where the hot words sit in a layout, measured once its SVG is on screen and its fonts are in. */
  const measure = (id: Layout["id"]) => {
    const map = new Map<HotKey, Pt & { w: number }>()
    root.querySelectorAll<SVGTSpanElement>(`svg[data-layout="${id}"] tspan[data-hot]`).forEach((el) => {
      try {
        const p = el.getStartPositionOfChar(0)
        map.set(el.dataset.hot as HotKey, { x: p.x, y: p.y, w: el.getComputedTextLength() })
      } catch {
        // Not rendered yet: measured again on the next font load.
      }
    })
    return map
  }
  const remeasure = () => {
    words = {}
    kick()
  }

  const apply = (c: Cue) => {
    if (c.kind === "state") setState(c.bot, c.label, c.agent)
    else if (c.kind === "lit") {
      lit.set(c.key, { bot: c.bot, t0: clock, dur: c.dur })
      setHot(c.key, true)
    } else if (c.kind === "check") {
      checks.set(c.bot, clock + 0.9)
      each(`[data-check="${c.bot}"]`, (el) => el.setAttribute("data-on", "true"))
    }
  }
  const arrive = (h: Hop) => {
    const { from, to } = EDGES[h.edge]
    if (h.major) effects.push({ kind: "ring", node: h.back ? from : to, tone: h.bot, major: true, agent: h.agent, t0: clock })
    effects.push({ kind: "burst", edge: h.edge, end: !h.back, tone: h.bot, major: h.major, agent: h.agent, t0: clock })
  }

  /** Advances the cues from the last frame to now. */
  const advance = () => {
    if (clock < INTRO) {
      for (const edge of Object.keys(EDGES) as EdgeId[]) {
        const end = DEPTH[edge] * 0.55 + 0.7
        if (prevClock < end && clock >= end) effects.push({ kind: "burst", edge, end: true, tone: "ink", major: false, agent: false, t0: clock })
      }
    } else {
      const T = clock - INTRO
      const t = T % LOOP
      if (prev === null) {
        for (const bot of BOTS) {
          const now = started(bot, T) ? stateAt(bot, t) : null
          setState(bot, now?.label ?? "Idle", now?.agent)
        }
      }
      else if (t !== prev) {
        for (const c of TIMELINE.cues) if (crossed(c.t, prev, t) && started(c.bot, T)) apply(c)
        for (const h of TIMELINE.hops) if (crossed((h.t + h.dur) % LOOP, prev, t) && (!h.major || started(h.bot, T - h.dur))) arrive(h)
      }
      prev = t
    }
    prevClock = clock
    for (const [key, l] of lit) {
      if (clock > l.t0 + l.dur) {
        lit.delete(key)
        setHot(key, false)
      }
    }
    for (const [bot, until] of checks) {
      if (clock > until) {
        checks.delete(bot)
        each(`[data-check="${bot}"]`, (el) => el.setAttribute("data-on", "false"))
      }
    }
    effects = effects.filter((e) => clock - e.t0 < 0.9)

    // The step tracks: where each bot is in its cycle.
    const T = clock - INTRO
    const on = [false, false, false]
    BOTS.forEach((bot, b) => {
      const at = started(bot, T) ? phaseAt(bot, T % LOOP) : null
      pips[b].forEach((pip, i) => {
        if (!pip) return
        pip.style.opacity = at?.step === i ? "1" : "0"
        if (at?.step === i) pip.style.left = `${at.p * 100}%`
      })
      if (at) on[at.step] = true
    })
    steps.forEach((el, i) => el?.setAttribute("data-active", String(on[i])))
  }

  const packet = (ctx: CanvasRenderingContext2D, r: Route, u1: number, back: boolean, rgb: RGB, major: boolean, alpha: number, dur: number, ghost: boolean) => {
    const u0 = u1 - TAIL / dur
    if (u0 >= 1 || u1 <= 0) return
    const s1 = sine(u1) * r.len
    const s0 = sine(u0) * r.len
    const at = (s: number) => r.at(back ? r.len - s : s)
    const head = at(s1)
    if (s1 - s0 > 0.5) {
      const tail = at(s0)
      const n = Math.max(2, Math.ceil((s1 - s0) / 3))
      ctx.beginPath()
      for (let i = 0; i <= n; i++) {
        const p = at(s0 + ((s1 - s0) * i) / n)
        if (i) ctx.lineTo(p.x, p.y)
        else ctx.moveTo(p.x, p.y)
      }
      const g = ctx.createLinearGradient(tail.x, tail.y, head.x, head.y)
      g.addColorStop(0, rgba(rgb, 0))
      g.addColorStop(1, rgba(rgb, alpha * (major ? 0.95 : 0.6)))
      ctx.strokeStyle = g
      ctx.lineWidth = major && !ghost ? 2 : 1.4
      ctx.setLineDash(ghost ? [3, 2.5] : [])
      ctx.stroke()
      ctx.setLineDash([])
    }
    if (u1 < 1) {
      const radius = major ? 2.6 : 1.8
      const glow = ctx.createRadialGradient(head.x, head.y, 0, head.x, head.y, radius * 5)
      glow.addColorStop(0, rgba(rgb, alpha * (colors.dark ? 0.6 : 0.32) * (ghost ? 0.5 : 1)))
      glow.addColorStop(1, rgba(rgb, 0))
      ctx.fillStyle = glow
      ctx.beginPath()
      ctx.arc(head.x, head.y, radius * 5, 0, Math.PI * 2)
      ctx.fill()
      const core = rgba(colors.dark ? mix(rgb, [255, 255, 255], 0.4) : rgb, alpha)
      ctx.beginPath()
      if (ghost) {
        ctx.strokeStyle = core
        ctx.lineWidth = 1.3
        ctx.arc(head.x, head.y, radius + 0.3, 0, Math.PI * 2)
        ctx.stroke()
      } else {
        ctx.fillStyle = core
        ctx.arc(head.x, head.y, radius, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }

  const paint = (ctx: CanvasRenderingContext2D, l: Layout) => {
    const hover = live.hover
    // While a node is hovered, everything not touching it fades, as in the SVG.
    const faded = (edge: EdgeId) => (hover && EDGES[edge].from !== hover && EDGES[edge].to !== hover ? 0.15 : 1)
    const fadedNode = (n: NodeId) => (hover && n !== hover && !NEIGHBOURS.get(hover)?.has(n) ? 0.15 : 1)
    const additive = colors.dark ? "lighter" : "source-over"
    ctx.lineCap = "round"
    ctx.lineJoin = "round"

    if (clock < INTRO) {
      ctx.globalCompositeOperation = additive
      for (const edge of Object.keys(EDGES) as EdgeId[]) packet(ctx, l.routes[edge], (clock - DEPTH[edge] * 0.55) / 0.7, false, colors.ink, false, 0.8 * faded(edge), 0.7, false)
    } else {
      const T = clock - INTRO
      const t = T % LOOP
      const llm = l.nodes.llm
      const thinking = THINKS.flatMap((c) => [t, t + LOOP].filter((tt) => tt >= c.t && tt < c.t + c.dur && started(c.bot, T - (tt - c.t))).map((tt) => ({ c, u: (tt - c.t) / c.dur })))

      // The model at work: a shimmer across it, a comet around its edge (dashed for the agent), its
      // GPUs busy.
      for (const { c, u } of thinking) {
        const rgb = color(c.bot)
        const env = Math.min(1, u * 6, (1 - u) * 5)
        ctx.save()
        ctx.beginPath()
        ctx.roundRect(llm.x, llm.y, llm.w, llm.h, 8)
        ctx.clip()
        const sweep = llm.x - 80 + ((clock * 0.8) % 1) * (llm.w + 160)
        const band = ctx.createLinearGradient(sweep - 70, 0, sweep + 70, 0)
        band.addColorStop(0, rgba(rgb, 0))
        band.addColorStop(0.5, rgba(rgb, 0.1 * env * fadedNode("llm")))
        band.addColorStop(1, rgba(rgb, 0))
        ctx.fillStyle = band
        ctx.fillRect(llm.x, llm.y, llm.w, llm.h)
        ctx.restore()

        const ring = OUTLINES[l.id]
        const head = (((clock * 0.9 + (c.bot === "stock" ? 0.5 : 0)) % 1) + 1) % 1
        const span = 0.32
        const n = 48
        // Butt caps: round ones overlap between segments and bead the comet under additive blending.
        ctx.lineCap = "butt"
        ctx.globalCompositeOperation = additive
        for (const [width, a] of [
          [5, 0.18],
          [1.6, 0.95],
        ] as const) {
          for (let i = 0; i < n; i++) {
            const s0 = (head - span + (span * i) / n + 1) % 1
            const s1 = (head - span + (span * (i + 1)) / n + 1) % 1
            const p0 = ring.at(s0 * ring.len)
            const p1 = ring.at(s1 * ring.len)
            if (Math.hypot(p1.x - p0.x, p1.y - p0.y) > 20 || (c.agent && i % 2)) continue
            ctx.strokeStyle = rgba(rgb, a * env * fadedNode("llm") * ((i + 1) / n) ** 1.6)
            ctx.lineWidth = width
            ctx.beginPath()
            ctx.moveTo(p0.x, p0.y)
            ctx.lineTo(p1.x, p1.y)
            ctx.stroke()
          }
        }
        ctx.globalCompositeOperation = "source-over"
        ctx.lineCap = "round"
      }
      if (thinking.length) {
        const env = Math.max(...thinking.map(({ u }) => Math.min(1, u * 6, (1 - u) * 5)))
        const rgb = color(thinking[thinking.length - 1].c.bot)
        gpuMeters(llm).forEach((m, i) => {
          const level = env * (0.55 + 0.35 * Math.sin(clock * (7 + i * 2.3) + i) * Math.sin(clock * 3.1 + i * 2))
          ctx.fillStyle = rgba(rgb, 0.9 * fadedNode("llm"))
          ctx.beginPath()
          ctx.roundRect(m.x, m.y + m.h * (1 - level), m.w, m.h * level, 2)
          ctx.fill()
        })
      }

      // Words being read or written, underlined in the bot's color.
      const measured = (words[l.id] ??= measure(l.id))
      for (const [key, w] of lit) {
        const at = measured.get(key)
        if (!at) continue
        const u = (clock - w.t0) / w.dur
        ctx.strokeStyle = rgba(color(w.bot), 0.9 * Math.min(1, (1 - u) * 4) * fadedNode(key.split(":")[0] as NodeId))
        ctx.lineWidth = 1.25
        ctx.beginPath()
        ctx.moveTo(at.x, at.y + 3)
        ctx.lineTo(at.x + at.w * easeOut(u * 4), at.y + 3)
        ctx.stroke()
      }

      // A busy engine's status dot breathes.
      for (const bot of BOTS) {
        if (!busy[bot]) continue
        const p = statusDot(l.nodes[bot], l.type)
        const u = (clock / 1.6 + (bot === "stock" ? 0.5 : 0)) % 1
        ctx.strokeStyle = rgba(color(bot), 0.5 * (1 - u) * fadedNode(bot))
        ctx.lineWidth = 1.2
        ctx.setLineDash(agentAtWork[bot] ? [2, 2] : [])
        ctx.beginPath()
        ctx.arc(p.x, p.y, 3 + 5 * easeOut(u), 0, Math.PI * 2)
        ctx.stroke()
      }
      ctx.setLineDash([])

      ctx.globalCompositeOperation = additive
      for (const h of TIMELINE.hops) {
        for (const tt of [t, t + LOOP]) {
          if (tt < h.t || tt > h.t + h.dur + TAIL || (h.major && !started(h.bot, T - (tt - h.t)))) continue
          packet(ctx, l.routes[h.edge], (tt - h.t) / h.dur, h.back, color(h.bot), h.major, faded(h.edge), h.dur, h.agent)
        }
      }
    }

    // Arrivals: a ring around the node, a ripple at the port.
    for (const e of effects) {
      const u = (clock - e.t0) / (e.kind === "ring" ? 0.8 : 0.55)
      if (u >= 1) continue
      const fade = e.kind === "ring" ? fadedNode(e.node) : faded(e.edge)
      ctx.strokeStyle = rgba(color(e.tone), (e.kind === "ring" ? 0.42 : e.major ? 0.55 : 0.3) * (1 - u) ** 2 * fade)
      ctx.lineWidth = 1.25
      ctx.beginPath()
      if (e.kind === "ring") {
        const b = l.nodes[e.node]
        const grow = 1 + 6 * easeOut(u)
        ctx.roundRect(b.x - grow, b.y - grow, b.w + grow * 2, b.h + grow * 2, 8 + grow)
      } else {
        const p = e.end ? l.routes[e.edge].end : l.routes[e.edge].at(0)
        ctx.arc(p.x, p.y, 2 + (e.major ? 10 : 6) * easeOut(u), 0, Math.PI * 2)
      }
      ctx.setLineDash(e.agent ? [3, 3] : [])
      ctx.stroke()
    }
    ctx.setLineDash([])
    ctx.globalCompositeOperation = "source-over"
  }

  const draw = () => {
    for (const canvas of canvases) {
      const width = canvas.clientWidth
      if (!width) continue
      const l = LAYOUTS[canvas.dataset.layout as Layout["id"]]
      const dpr = Math.min(2, devicePixelRatio || 1)
      const pw = Math.round(width * dpr)
      const ph = Math.round(canvas.clientHeight * dpr)
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw
        canvas.height = ph
      }
      const ctx = canvas.getContext("2d")
      if (!ctx) continue
      const scale = (width / l.w) * dpr
      ctx.setTransform(scale, 0, 0, scale, 0, 0)
      ctx.clearRect(0, 0, l.w, l.h)
      if (clock > 0) paint(ctx, l)
    }
  }

  const frame = (now: number) => {
    raf = 0
    const running = live.playing && visible && !document.hidden
    if (running) {
      clock += last ? Math.min(0.1, (now - last) / 1000) : 0
      last = now
      raf = requestAnimationFrame(frame)
    } else last = 0
    if (clock > 0) advance()
    draw()
  }
  const kick = () => {
    if (!raf) raf = requestAnimationFrame(frame)
  }

  const io = new IntersectionObserver(
    (entries) => {
      visible = entries.some((e) => e.isIntersecting)
      kick()
    },
    { rootMargin: "64px" },
  )
  io.observe(root)
  const theme = new MutationObserver(() => {
    colors = read()
    kick()
  })
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
  const resize = new ResizeObserver(remeasure)
  canvases.forEach((c) => resize.observe(c))
  document.addEventListener("visibilitychange", kick)
  document.fonts?.addEventListener("loadingdone", remeasure)

  return {
    kick,
    dispose: () => {
      cancelAnimationFrame(raf)
      io.disconnect()
      theme.disconnect()
      resize.disconnect()
      document.removeEventListener("visibilitychange", kick)
      document.fonts?.removeEventListener("loadingdone", remeasure)
    },
  }
}
