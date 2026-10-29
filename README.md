# Marketbots

Two autonomous, AI-driven paper-trading bots in one pnpm monorepo:

- **CryptoMarketBot** trades Kraken spot pairs 24/7 in a Kraken CLI paper wallet. Dashboard: [cryptomarketbot.app](https://cryptomarketbot.app).
- **StockMarketBot** trades US stocks and defined-risk options on market days in an Alpaca paper account. Dashboard: [stockmarketbot.app](https://stockmarketbot.app).

In both, a local model (Qwen 3.6 35B-A3B, on the server's two GPUs) researches through our own web search and decides, and deterministic code sizes and checks every order. Beside those scheduled cycles, each bot runs an agent on the same model: code wakes it when something matters, it looks things up step by step, and, in shadow, its decisions fill in a simulated book so its record can be compared with the bot's. Each bot has its own always-on engine, its own Next.js dashboard on Vercel with its own owner sign-in, and its own database on MongoDB Atlas. One Docker stack, `marketbots`, runs on the owner's Windows server: both engines, the local model server, a web search service (SearXNG), a shared headless scraper and the history store (Postgres with TimescaleDB: price bars and the news archive).

**Paper trading only.** Neither engine has a live-trading code path.

## Architecture

### Runtime topology

```mermaid
flowchart LR
    browser[Browser]
    dashboards[Vercel dashboards]
    atlas[(MongoDB Atlas<br/>separate database per bot)]
    services[Kraken paper wallet<br/>Alpaca paper account<br/>news sources]
    internet[Search engines<br/>and article pages]

    subgraph server["marketbots Docker stack, on the owner's server"]
        crypto[Crypto engine]
        stock[Stock engine]
        llm[Local LLM, Qwen 3.6 on two GPUs<br/>research, decisions, summaries]
        search[Web search<br/>SearXNG]
        scraper[Shared scraper]
        history[(History store<br/>price bars and news archive)]
    end

    browser -->|HTTPS| dashboards
    dashboards -->|Read data and write commands| atlas
    browser -->|Engine WebSocket stream| crypto
    browser -->|Engine WebSocket stream| stock
    crypto -->|Own trading state| atlas
    stock -->|Own trading state| atlas
    crypto & stock --> llm
    crypto & stock --> search
    crypto & stock --> scraper
    crypto & stock --> history
    crypto & stock --> services
    search & scraper --> internet
```

## Layout

```
apps/crypto-engine/     crypto engine (Docker)
apps/crypto-web/        crypto dashboard (Vercel)
apps/stock-engine/      stock engine (Docker)
apps/stock-web/         stock dashboard (Vercel)
apps/scraper/           headless Chromium sidecar shared by both engines (own npm lockfile)
packages/config/        tsconfig base, ESLint presets with the import boundaries, Vitest presets
packages/core/          pure shared schemas and helpers, no I/O
packages/engine-kit/    engine runtime shared by both engines
packages/wire/          the news engine, shared by both engines
packages/history/       the history store client (Postgres): bars and news archive, shared by both engines
packages/ui/            client-safe React shared by both dashboards
packages/web-kit/       server-only dashboard helpers
packages/crypto-core/   crypto schemas and types
packages/stock-core/    stock schemas and types
contracts/              behavior snapshots per bot
docs/                   architecture, per-bot design, server runbook
compose.yml             the marketbots stack: both engines, the local LLM, search, the scraper, the history store
.env.crypto.example     every crypto variable, by where it's used (copy to .env.crypto)
.env.stock.example      every stock variable, by where it's used (copy to .env.stock)
```

## Development

Node 22.12+ and pnpm 10. Copy `.env.crypto.example` to `.env.crypto` and `.env.stock.example` to `.env.stock` at the repo root, and put local overrides (a `_dev` database, no Discord, fake Alpaca keys) in `.env.crypto.local` / `.env.stock.local`. See [docs/SERVER.md §3](docs/SERVER.md#3-the-env-files).

```bash
pnpm install
pnpm typecheck && pnpm test && pnpm lint && pnpm build   # the gate before every deploy

pnpm dev:crypto-engine    # crypto engine (tsx watch); needs the Kraken CLI on PATH
pnpm dev:crypto-web       # crypto dashboard (next dev)
pnpm dev:stock-engine     # stock engine (tsx watch)
pnpm dev:stock-web        # stock dashboard (next dev)

# crypto backtest from the command line (public Kraken data, no database)
pnpm backtest -- --symbols BTC/USD,ETH/USD,SOL/USD --strategies trend,momentum --interval 240
```

`build`, `test`, `typecheck` and `lint` run in every workspace package (`pnpm -r`). The dev scripts read `.env.<bot>`, then `.env.<bot>.local`. The scraper sits outside the pnpm workspace (own npm lockfile) and is built only as its Docker image.

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): the platform: topology, layout, what is shared and what stays per bot.
- [docs/CRYPTO.md](docs/CRYPTO.md), [docs/STOCK.md](docs/STOCK.md): each bot's design.
- [docs/SERVER.md](docs/SERVER.md): the server, the Docker stack, env files, deploys, Vercel, troubleshooting.
- [AGENTS.md](AGENTS.md): conventions for changing this repo (package boundaries, shared code, safety rules).

Paper trading with simulated money for research. Not financial advice; nothing here guarantees profits, and options can lose their entire value.
