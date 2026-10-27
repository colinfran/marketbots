import { execFile } from "node:child_process"
import { errorMessage, type Logger } from "../../log"

/**
 * Wrapper around the official Kraken CLI's paper trading (github.com/krakenfx/kraken-cli). A
 * paper workspace is a simulated Kraken spot wallet: market orders fill at the live Kraken ticker
 * (buys at ask × (1 + slippage), sells at bid × (1 − slippage)), and the fee is cost × fee_rate.
 * The CLI keeps the wallet's journal under $XDG_CONFIG_HOME/kraken/workspaces/<name>/, which the
 * Docker setup puts on a named volume.
 *
 * Safety:
 * - the binary is run with execFile and an argument array (no shell, nothing to inject into);
 * - the child gets a minimal environment, so the engine's secrets never reach it;
 * - calls are strictly serialized, because the workspace journal holds a single writer lock;
 * - every call has a timeout. A timeout on an order is an *uncertain* outcome, which the caller
 *   resolves by reconciling against the wallet's trade history, never by retrying.
 */

export type CliErrorKind = "rejected" | "timeout" | "missing" | "failed" | "bad_output"

export class KrakenCliError extends Error {
  constructor(
    message: string,
    readonly kind: CliErrorKind,
  ) {
    super(message)
    this.name = "KrakenCliError"
  }
}

export type CliFill = {
  tradeId: string
  orderId: string
  pair: string
  side: "buy" | "sell"
  volume: number
  price: number
  fee: number
  cost: number
}

export type CliTrade = CliFill & { time: Date | null }

export type CliBalances = Record<string, { total: number; reserved: number; available: number }>

export type CliWorkspace = { name: string; capital: number; currency: string; feeRate: number; slippageRate: number; createdAt: string | null }

export type ExecFn = (
  file: string,
  args: string[],
  options: { timeout: number; env: NodeJS.ProcessEnv; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>

const defaultExec: ExecFn = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { ...options, encoding: "utf8", windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }))
      else resolve({ stdout, stderr })
    })
  })

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN
  if (!Number.isFinite(n)) throw new KrakenCliError(`expected a number, got ${JSON.stringify(v)}`, "bad_output")
  return n
}

const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v))

/** Kraken's legacy asset codes vs the v2 names the engine uses. */
const ASSET_ALIASES: Record<string, string> = { XBT: "BTC", XXBT: "BTC", XDG: "DOGE", XXDG: "DOGE", ZUSD: "USD" }
export const normalizeAsset = (asset: string) => ASSET_ALIASES[asset.toUpperCase()] ?? asset.toUpperCase()
/** "XBTUSD" / "BTC/USD" / "xbt/usd" → "BTC/USD" (for USD-quoted pairs). */
export const normalizePair = (pair: string) => {
  const p = pair.toUpperCase()
  const [base, quote] = p.includes("/") ? p.split("/") : [p.replace(/Z?USD$/, ""), "USD"]
  return `${normalizeAsset(base)}/${normalizeAsset(quote)}`
}

/** Pulls the JSON document out of CLI output (it may print warnings around it). */
const parseJson = (text: string): unknown => {
  const trimmed = text.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    // NDJSON or log lines before the payload: take the last line that parses.
    for (const line of trimmed.split("\n").reverse()) {
      try {
        return JSON.parse(line)
      } catch {}
    }
    return null
  }
}

const errorText = (body: unknown): string | null => {
  const b = body as { error?: unknown; message?: unknown } | null
  const e = b?.error
  if (!e) return null
  // CLI 0.4.1's envelope: {"error": "<category>", "message": "<what went wrong>"}.
  if (typeof e === "string") return typeof b?.message === "string" && b.message ? b.message : e
  const o = e as { message?: unknown; code?: unknown }
  return [o.code, o.message].filter(Boolean).map(String).join(": ") || JSON.stringify(e)
}

export class KrakenCli {
  private tail: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly bin: string,
    readonly workspace: string,
    private readonly timeoutMs: number,
    private readonly log: Logger,
    private readonly exec: ExecFn = defaultExec,
  ) {}

  private childEnv(): NodeJS.ProcessEnv {
    const keep = ["PATH", "HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR"]
    const env: NodeJS.ProcessEnv = { NO_COLOR: "1", KRAKEN_WORKSPACE: this.workspace }
    for (const k of keep) if (process.env[k]) env[k] = process.env[k]
    return env
  }

  /** Runs one CLI command with JSON output, serialized behind any in-flight command. */
  private run(args: string[], { json = true, timeoutMs = this.timeoutMs } = {}): Promise<unknown> {
    const job = this.tail.then(async () => {
      const fullArgs = json ? [...args, "-o", "json"] : args
      const started = Date.now()
      this.log.debug("kraken cli", { args: fullArgs.join(" ") })
      try {
        const { stdout, stderr } = await this.exec(this.bin, fullArgs, { timeout: timeoutMs, env: this.childEnv(), maxBuffer: 16 * 1024 * 1024 })
        this.log.debug("kraken cli done", { cmd: args.slice(0, 2).join(" "), ms: Date.now() - started })
        if (!json) return stdout.trim()
        const body = parseJson(stdout) ?? parseJson(stderr)
        const err = errorText(body)
        if (err) throw new KrakenCliError(err, "rejected")
        if (body === null) throw new KrakenCliError(`no JSON output from \`kraken ${args.join(" ")}\``, "bad_output")
        return body
      } catch (error) {
        if (error instanceof KrakenCliError) throw error
        const e = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string; stdout?: string; stderr?: string }
        if (e.code === "ENOENT") throw new KrakenCliError(`Kraken CLI not found at "${this.bin}"`, "missing")
        if (e.killed || e.signal === "SIGTERM") throw new KrakenCliError(`\`kraken ${args[0]} ${args[1] ?? ""}\` timed out after ${timeoutMs}ms`, "timeout")
        // Non-zero exit: the CLI reports rejections as a JSON error envelope.
        const body = parseJson(e.stdout ?? "") ?? parseJson(e.stderr ?? "")
        const err = errorText(body)
        if (err) throw new KrakenCliError(err, "rejected")
        throw new KrakenCliError(`kraken ${args.slice(0, 2).join(" ")} failed: ${(e.stderr || errorMessage(error)).slice(0, 400)}`, "failed")
      }
    })
    // Keep the queue alive whatever this job does.
    this.tail = job.catch(() => undefined)
    return job
  }

  async version(): Promise<string> {
    const out = (await this.run(["--version"], { json: false, timeoutMs: 10_000 })) as string
    return out.replace(/^kraken(-cli)?\s*/i, "").trim() || out
  }

  async showWorkspace(): Promise<CliWorkspace | null> {
    try {
      const w = (await this.run(["workspace", "show", this.workspace])) as Record<string, unknown>
      return {
        name: str(w.name) || this.workspace,
        capital: num(w.capital),
        currency: str(w.currency) || "USD",
        feeRate: num(w.fee_rate ?? 0),
        slippageRate: num(w.slippage_rate ?? 0),
        createdAt: str(w.created_at) || null,
      }
    } catch (error) {
      if (error instanceof KrakenCliError && error.kind === "rejected" && /not found|does not exist|no such|unknown workspace/i.test(error.message)) return null
      throw error
    }
  }

  async createWorkspace({ capital, feeRate, slippageRate }: { capital: number; feeRate: number; slippageRate: number }) {
    await this.run([
      "workspace",
      "create",
      this.workspace,
      "--capital",
      String(capital),
      "--mode",
      "paper",
      "--currency",
      "USD",
      "--fee-rate",
      String(feeRate),
      "--slippage-rate",
      String(slippageRate),
    ])
  }

  /** Starts a new capital epoch (history is retained by the CLI, balances reset). */
  async reset({ capital, feeRate, slippageRate }: { capital: number; feeRate: number; slippageRate: number }) {
    await this.run(["paper", "reset", "--capital", String(capital), "--fee-rate", String(feeRate), "--slippage-rate", String(slippageRate), "--yes"])
  }

  /** A market order; returns the fill. `volume` must already be rounded to the pair's lot size. */
  async marketOrder(side: "buy" | "sell", pair: string, volume: string): Promise<CliFill> {
    if (!/^\d+(\.\d+)?$/.test(volume)) throw new KrakenCliError(`invalid volume ${volume}`, "rejected")
    if (!/^[A-Z0-9]{2,12}\/[A-Z]{3,4}$/.test(pair)) throw new KrakenCliError(`invalid pair ${pair}`, "rejected")
    const r = (await this.run(["paper", side, pair, volume])) as Record<string, unknown>
    if (r.action !== "market_order_filled") throw new KrakenCliError(`unexpected order response: ${JSON.stringify(r).slice(0, 300)}`, "bad_output")
    return {
      tradeId: str(r.trade_id),
      orderId: str(r.order_id),
      pair: normalizePair(str(r.pair) || pair),
      side: r.side === "sell" ? "sell" : "buy",
      volume: num(r.volume),
      price: num(r.price),
      fee: num(r.fee),
      cost: num(r.cost),
    }
  }

  async balance(): Promise<CliBalances> {
    const r = (await this.run(["paper", "balance"])) as { balances?: Record<string, { total?: unknown; reserved?: unknown; available?: unknown }> }
    const out: CliBalances = {}
    for (const [asset, b] of Object.entries(r.balances ?? {})) {
      out[normalizeAsset(asset)] = { total: num(b.total ?? 0), reserved: num(b.reserved ?? 0), available: num(b.available ?? 0) }
    }
    return out
  }

  /** Filled trades of the current capital epoch, oldest first. */
  async history(): Promise<CliTrade[]> {
    const r = (await this.run(["paper", "history"])) as { trades?: Record<string, unknown>[] }
    return (r.trades ?? [])
      .map((t) => {
        const time = t.time ? new Date(str(t.time)) : null
        return {
          tradeId: str(t.id),
          orderId: str(t.order_id),
          pair: normalizePair(str(t.pair)),
          side: (t.side === "sell" ? "sell" : "buy") as "buy" | "sell",
          volume: num(t.volume),
          price: num(t.price),
          fee: num(t.fee ?? 0),
          cost: num(t.cost ?? 0),
          time: time && !Number.isNaN(time.getTime()) ? time : null,
        }
      })
      .sort((a, b) => (a.time?.getTime() ?? 0) - (b.time?.getTime() ?? 0))
  }
}
