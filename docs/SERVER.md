# Server setup and operations

How the `marketbots` Docker stack runs on the Windows server: first-time setup, the env file, everyday commands, the paper wallet volume, the swap from the old stacks, the Vercel projects, the local LLM and troubleshooting. Commands are for **PowerShell** on the server, run from the repo root (`C:\Users\colin\Documents\GitHub\marketbots`) unless noted.

This replaces both old `docs/WINDOWS_SERVER_SETUP.md` guides (cryptomarketbot and stockmarketbot). How the pieces fit together: [ARCHITECTURE.md](ARCHITECTURE.md).

What runs where:

| Where | What | Config |
| --- | --- | --- |
| Windows server, Docker stack `marketbots` | `crypto-engine` on 127.0.0.1:8787 (with the Kraken CLI paper wallet), `stock-engine` on 127.0.0.1:8788, `scraper` (no host port), `llm` (llama.cpp with the local model on both GPUs, no host port), `search` (SearXNG for local research, no host port), `history` (Postgres with TimescaleDB and pgvector, no host port) and `history-backup` | `compose.yml`, `.env` at the repo root |
| Caddy on the Windows host | `engine.cryptomarketbot.app` → 127.0.0.1:8787, `engine.stockmarketbot.app` → 127.0.0.1:8788 (WebSocket) | `C:\Caddy\Caddyfile` |
| The Windows host, outside Docker | The host agent and its LibreHardwareMonitor (Admin → Server, the motherboard fans; §11) | `.env` at the repo root (its HOST section) |
| Vercel | two projects: `apps/crypto-web` at cryptomarketbot.app, `apps/stock-web` at stockmarketbot.app | each project's environment variables |
| Azure DocumentDB (MongoDB-compatible, free tier) | one cluster, databases `cryptomarketbot`, `stockmarketbot` and `serverstats` | `MONGODB_URI` |
| Alpaca | the stock bot's paper account | `.env` (`STOCK_ALPACA_*`, engine only) |

The two engines are independent: separate images, containers, ports, variables, databases, leases and stream secrets. Deploying, restarting or crashing one never touches the other. At runtime they share only the scraper, the LLM, the history service (each with its own database and role on it) and the server's IP address.

---

## 1. Accounts and secrets (once)

**Azure DocumentDB** (MongoDB-compatible; the free tier: 32 GB): one cluster serves both bots, each in its own database, and the host agent's `serverstats` (§11).
1. The cluster's admin user, with a long random password (no `$`, §3.3). Users can't be limited to one database: every user sees the whole cluster.
2. *Networking*: the firewall rule `0.0.0.0 – 255.255.255.255`. Vercel connects from changing IPs (and isn't on Azure, so *Allow Azure services* doesn't cover it); the strong password is the protection. With no rule, nothing connects.
3. *Connection strings*: copy the `mongodb+srv://…` string and put the password in.

The free tier has no backups and no high availability, and pauses after 60 days without a connection (the engines are always connected). One free cluster per Azure subscription. Admin → System's *Database storage* card shows how full the disk is. With the four `AZURE_*` variables (below) it shows Azure Monitor's count, `StorageUsed` against the disk it fills, and splits it into the databases (as MongoDB reports them) and *Logs and system files*: the rest, the database engine's write-ahead log, its own files and working space. On 2026-10-30 that was 4.6 GB of 31.2 GB: 193 MB of databases, 4.4 GB of the rest. Without them it shows only what MongoDB reports, against `DB_STORAGE_LIMIT_BYTES` in `@mb/core/db` (32 GB).

**Azure Monitor for the card** (optional): a service principal that can read the cluster's metrics and nothing else. Once, with the Azure CLI signed in as the subscription's owner (`az login`):

```powershell
$id = az resource list --resource-type Microsoft.DocumentDB/mongoClusters --query "[0].id" --output tsv
az ad sp create-for-rbac --name marketbots-metrics --role "Monitoring Reader" --scopes $id --years 2
```

Its output has `tenant`, `appId` and `password`: they go into `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET`, and `$id` into `AZURE_DOCUMENTDB_RESOURCE_ID`, on both Vercel projects (§3.4) and in `.env` (SHARED) for local dev. The secret expires after 2 years: the card then shows *Azure sign-in failed (HTTP 401)*; run `az ad sp credential reset --id <appId> --years 2` and update the four places.

**Alpaca (stock)**: the paper account, reset to **10,000**. Total return is measured from $10,000 and every P&L number comes from Alpaca, so the account belongs to this bot alone. A reset can issue new keys. Debit spreads need **options level 3** (Admin shows the level the engine sees). Alpaca's free market-data stream allows **one connection per account**: never run a second engine, script or notebook with these keys.

**Kraken (crypto)**: no account and no keys. Market data is public; orders go to the Kraken CLI paper wallet inside the container.

**AI**: no outside AI service and no AI key. Both engines use the local model server and its search service (§9).

**useSend** (`USESEND_API_KEY`, `USESEND_BASE_URL`, `USESEND_FROM_EMAIL`; no defaults): sends the owner's sign-in magic links, and the sign-in codes the dashboard asks for when it runs as an installed Home Screen app (that app keeps its own cookies, so a link opened in the browser wouldn't sign it in). Links and codes only ever go to `OWNER_EMAIL`; nobody else can sign in.

**Random secrets**: each bot has its own `STREAM_TOKEN_SECRET` and `BETTER_AUTH_SECRET`; never reuse one across bots. Generate each with:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**News API keys** (optional, free): listed in `.env.example`, the ones both bots use in SHARED, each bot's own in its section. A source whose key is empty stays off.

---

## 2. Server prerequisites (once)

The server is a shared Windows 11 Pro home PC (i5-11400, 32 GB RAM, an RTX 3070 8 GB and an RTX 2080 SUPER 8 GB) that also runs Jellyfin, a torrent stack, useSend and other containers. Every service in this stack has a memory cap (§5.5).

**Docker Desktop** with the WSL2 backend; the engines are Linux containers. In *Settings → General*, enable *Start Docker Desktop when you sign in*, and make sure the machine signs in after a reboot, or Docker won't start. The Docker VM has 15.5 GiB (half the host's RAM, no `.wslconfig`), which is enough. Docker's disk, and with it every named volume, is on C: (`%LOCALAPPDATA%\Docker\wsl\disk`).

```powershell
docker version          # "Server: ... OS/Arch: linux/amd64" (not windows/amd64)
docker compose version
git --version
node --version          # 22.12 or newer (local dev, the secret one-liner)
```

If it says `windows/amd64`, switch Docker Desktop to Linux containers (tray icon → *Switch to Linux containers*).

**GPU power limit:** under model work the RTX 2080 SUPER reached 91 °C at its default 250 W ([LOCAL-AI.md §5.1](plans/LOCAL-AI.md#51-step-0-results-2026-102728)), so it runs capped at 180 W. Generating text is limited by memory bandwidth, and the cap cost no measurable speed. The driver forgets the cap on restart, so a startup task sets it again. Once, from an administrator PowerShell:

```powershell
$uuid = "GPU-c2f63837-86e4-7c90-764a-3de017193048"   # the 2080 SUPER (nvidia-smi -L)
nvidia-smi -i $uuid -pl 180
$trigger = New-ScheduledTaskTrigger -AtStartup; $trigger.Delay = "PT1M"
Register-ScheduledTask -TaskName "GPU power limit (2080 SUPER)" -TaskPath "\marketbots\" -Trigger $trigger `
  -Action (New-ScheduledTaskAction -Execute "C:\Windows\System32\nvidia-smi.exe" -Argument "-i $uuid -pl 180") `
  -Principal (New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest)
nvidia-smi --query-gpu=name,power.limit,power.default_limit --format=csv   # 180.00 W on the 2080 SUPER
```

**Caddy** runs on the Windows host, not in Docker: `C:\Caddy\caddy.exe run --config C:\Caddy\Caddyfile`, started by a scheduled task (`C:\Caddy\CaddyTray.ps1` is its tray controller). It terminates TLS and passes WebSocket upgrades through on its own. The engine sites:

```caddy
engine.cryptomarketbot.app {
	reverse_proxy 127.0.0.1:8787
}

engine.stockmarketbot.app {
	reverse_proxy 127.0.0.1:8788
}
```

The ports are the same as before the merge, so Caddy needs no change. After editing the Caddyfile for some other reason: `C:\Caddy\caddy.exe reload --config C:\Caddy\Caddyfile`. The engines serve only `/v1/stream`, `/healthz` and `/readyz`.

**The repo**:

```powershell
cd C:\Users\colin\Documents\GitHub
git clone https://github.com/colinfran/marketbots.git
cd marketbots
git config core.autocrlf false        # the repo is LF only (.gitattributes)
Copy-Item .env.example .env
notepad .env                          # every secret and setting, in sections (§3)
```

**The wallet volume**: on this server `cryptomarketbot_kraken-paper` already exists and holds the live paper wallet (§6). Only on a brand-new server, create it once with `docker volume create cryptomarketbot_kraken-paper`; the engine creates the workspace on first boot.

---

## 3. The env file

### 3.1 One file, in sections

`.env` at the repo root holds every secret and setting of the stack: both engines, both dashboards (for local dev; Vercel keeps its own copy), the history and search services, and the host agent. It is git-ignored and kept out of Docker build contexts (`.dockerignore`); only its template, `.env.example`, is committed. Its sections:

| Section | Names | Read by |
| --- | --- | --- |
| SHARED | no prefix: `MONGODB_URI`, the news and research keys, `OWNER_EMAIL`, useSend, Azure Monitor, the time zone | both bots; `MONGODB_URI` also the host agent |
| CRYPTO | `CRYPTO_*` | the crypto engine and dashboard |
| STOCK | `STOCK_*` | the stock engine and dashboard |
| HISTORY | `HISTORY_*` | the history service (§3.6) |
| SEARCH | `SEARCH_PROXY_URL` | the search service (§3.7) |
| HOST | `FAN_CONTROL`, `VESYNC_*`, `HOST_*` | the host agent (§11.1) |

The code reads a bot's variables without the prefix: `CRYPTO_MONGODB_DB_NAME` is the crypto engine's and dashboard's `MONGODB_DB_NAME`. In each bot's section, the comments say which variables its engine reads, which its dashboard, and which both.

- **Containers**: compose reads `.env` by itself (for the `${…}` in `compose.yml`), and `compose.yml` gives each service only its own variables, renamed (§3.2). An engine never sees the other bot's keys or the dashboards' secrets.
- **Vercel** can't read the file. Each project gets its dashboard's values under the names without the prefix (§3.4).
- **Local dev**: the `pnpm dev:*` scripts read `.env`, then `.env.local`, through `mb-env` (`packages/config/mb-env.mjs`), which renames them the same way (§3.5).
- **The host agent** reads `.env` directly (`node --env-file`); its names have no prefix (§11.1).

### 3.2 What each service gets

`compose.yml` lists every variable each service gets, and where from. Both engines get the SHARED section's `MONGODB_URI`, news keys (`SEC_USER_AGENT`, `FINNHUB_API_KEY`, `FRED_API_KEY`, `BLS_API_KEY`) and research keys (`TAVILY_API_KEY`, `EXA_API_KEY`, `BRIGHTDATA_*`), and their own section's variables without the prefix. compose sets these itself; don't put them in `.env`:

| Variable | crypto-engine | stock-engine |
| --- | --- | --- |
| `STREAM_HOST` | `0.0.0.0` | `0.0.0.0` |
| `STREAM_PORT` | `8787` | `8788` |
| `SCRAPER_URL` | `http://scraper:8790` | `http://scraper:8790` |
| `LLM_URL` | `http://llm:8080` | `http://llm:8080` |
| `SEARCH_URL` | `http://search:8080` | `http://search:8080` |
| `LOG_DIR` | `/logs` | `/logs` |
| `HISTORY_URL` | `postgres://crypto_history:<HISTORY_CRYPTO_PASSWORD>@history:5432/crypto_history` | `postgres://stock_history:<HISTORY_STOCK_PASSWORD>@history:5432/stock_history` |

Crypto also gets `KRAKEN_OHLCVT_DIR=/data/ohlcvt`, the read-only mount of Kraken's history files (§6.5). `history` gets the three `HISTORY_*` passwords, under the names its image and `initdb.sh` read (`POSTGRES_PASSWORD`, `CRYPTO_HISTORY_PASSWORD`, `STOCK_HISTORY_PASSWORD`); `history-backup` gets only the superuser's, and `search` only `SEARCH_PROXY_URL`.

A variable that isn't in `.env` reaches its container empty, and the engines read an empty value as unset, so the code's default applies. **A new variable** goes into `.env.example` and into the `environment` of each service that reads it in `compose.yml`: one that is only in `.env` reaches no container.

### 3.3 Rules

- One value per line, no trailing spaces. The engine trims stray `\r`.
- **A value containing `$`, a space or `#`** (a Mongo password, a sender like `CryptoMarketBot <no-reply@…>`) goes in single quotes: `MONGODB_URI='mongodb+srv://user:pa$word@…'`. Compose expands `$` in unquoted values; single quotes keep it literal for both compose and Node's `--env-file` (local dev, the host agent). The old `$$` escape doesn't work here: Node reads it as two dollar signs. On Vercel, paste the value without the quotes.
- compose finds `.env` in the project folder, so run compose from the repo root. Without the file every variable reaches the containers empty, and the engines stop at start (`Invalid engine environment`).
- **After editing** it, run `docker compose up -d <service>` for each service that reads what you changed (§3.2). That recreates the container with the new values; `restart` keeps the old ones.
- Never commit it or paste its contents anywhere. `docker compose config` without `--quiet` prints every value; don't share its output.

### 3.4 What goes into each Vercel project

Set for Production and Preview, under the Vercel name, with the value of the `.env` variable beside it. Vercel applies env changes to new deployments only, so redeploy after changing one.

**Crypto** (the cryptomarketbot.app project):

| Vercel variable | `.env` variable | Value |
| --- | --- | --- |
| `MONGODB_URI` | `MONGODB_URI` | same as the engine |
| `MONGODB_DB_NAME` | `CRYPTO_MONGODB_DB_NAME` | `cryptomarketbot` |
| `STREAM_TOKEN_SECRET` | `CRYPTO_STREAM_TOKEN_SECRET` | **identical** to the engine's |
| `BETTER_AUTH_SECRET` | `CRYPTO_BETTER_AUTH_SECRET` | 32+ characters; changing it signs you out everywhere |
| `OWNER_EMAIL` | `OWNER_EMAIL` | the only address that can sign in; required, no default |
| `USESEND_API_KEY`, `USESEND_BASE_URL` | the same names | the useSend key and its instance's URL; required, no defaults |
| `USESEND_FROM_EMAIL` | `CRYPTO_USESEND_FROM_EMAIL` | the verified sender; required, no default |
| `ENGINE_STREAM_URL` | `CRYPTO_ENGINE_STREAM_URL` | `wss://engine.cryptomarketbot.app/v1/stream` |
| `NEXT_PUBLIC_DISPLAY_TIMEZONE` | `NEXT_PUBLIC_DISPLAY_TIMEZONE` | `America/Los_Angeles` |
| `HOST_DB_NAME` | `HOST_DB_NAME` | optional: the host agent's database (default `serverstats`, §11) |
| `SITE_URL` | `CRYPTO_SITE_URL` | optional: defaults to the project's production domain |
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_DOCUMENTDB_RESOURCE_ID` | the same names | optional, all four or none: Azure Monitor's count of the database's storage on Admin → System (§1) |

**Stock** (the stockmarketbot.app project):

| Vercel variable | `.env` variable | Value |
| --- | --- | --- |
| `MONGODB_URI` | `MONGODB_URI` | same as the engine |
| `MONGODB_DB_NAME` | `STOCK_MONGODB_DB_NAME` | `stockmarketbot` |
| `STREAM_TOKEN_SECRET` | `STOCK_STREAM_TOKEN_SECRET` | **identical** to the engine's |
| `BETTER_AUTH_SECRET` | `STOCK_BETTER_AUTH_SECRET` | 32+ characters; changing it signs you out everywhere |
| `OWNER_EMAIL` | `OWNER_EMAIL` | the only address that can sign in; required, no default |
| `USESEND_API_KEY`, `USESEND_BASE_URL` | the same names | the useSend key and its instance's URL; required, no defaults |
| `USESEND_FROM_EMAIL` | `STOCK_USESEND_FROM_EMAIL` | the verified sender; required, no default |
| `ENGINE_STREAM_URL` | `STOCK_ENGINE_STREAM_URL` | `wss://engine.stockmarketbot.app/v1/stream` |
| `DISCORD_WEBHOOK_URL` | `STOCK_DISCORD_WEBHOOK_URL` | optional: unhandled dashboard errors go to the engine's Discord channel |
| `HOST_DB_NAME` | `HOST_DB_NAME` | optional: the host agent's database (default `serverstats`, §11) |
| `SITE_URL` | `STOCK_SITE_URL` | optional: defaults to the project's production domain |
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_DOCUMENTDB_RESOURCE_ID` | the same names | optional, all four or none: Azure Monitor's count of the database's storage on Admin → System (§1) |

Nothing else goes to Vercel: the dashboards hold no broker or AI keys. Vercel sets `VERCEL_PROJECT_PRODUCTION_URL` itself (the default for `SITE_URL`); sign in on the production domain, not on preview URLs.

### 3.5 Local dev overrides

`.env.local` (git-ignored) is read after `.env`, under the same names, and its values win. Local engines must not touch live state:

```ini
# .env.local
CRYPTO_MONGODB_DB_NAME=cryptomarketbot_dev
CRYPTO_DISCORD_WEBHOOK_URL=
STOCK_MONGODB_DB_NAME=stockmarketbot_dev
STOCK_DISCORD_WEBHOOK_URL=
STOCK_ALPACA_API_KEY=fake-key
STOCK_ALPACA_SECRET_KEY=fake-secret
```

- `mb-env <bot>` gives a dev process the variables without a bot prefix under their own names (the HISTORY, SEARCH and HOST ones too, which it doesn't read) and its bot's without the prefix, a bot's winning over a shared one of the same name; the other bot's are left out. The shell's own variables win over both files.
- On the live database a local engine would wait for the live engine's lease, and take over trading as soon as the live one stopped.
- A local engine keeps no history (only `compose.yml` builds `HISTORY_URL`, and `history` has no host port) and runs no AI (`LLM_URL` too is set only by compose), so it spends none of the research allowances.
- A local stock engine with the live keys would knock out the live engine's market data (one connection per account). With fake keys it boots and logs Alpaca auth errors.
- A local crypto engine needs the Kraken CLI on `PATH` (or `CRYPTO_KRAKEN_CLI_PATH` in `.env.local`) and uses that machine's own CLI workspace, never the server's volume.
- A local dashboard on the live database writes real commands that the live engine executes.

### 3.6 The history passwords

The HISTORY section holds the history service's three passwords:

| Variable | What |
| --- | --- |
| `HISTORY_POSTGRES_PASSWORD` | the Postgres superuser: creates the databases on the first start, and runs the nightly backup |
| `HISTORY_CRYPTO_PASSWORD` | the `crypto_history` role, which owns the `crypto_history` database and nothing else |
| `HISTORY_STOCK_PASSWORD` | the `stock_history` role, likewise |

compose builds each engine's `HISTORY_URL` from its bot's password (§3.2), so an engine can reach only its own database, and its URL can't drift from the password.

- The passwords take effect when the `history-data` volume is created (the first start, by `packages/history/docker/initdb.sh`). Changing one in `.env` afterwards changes nothing until Postgres changes too: `docker compose exec history psql -U postgres -c "alter role crypto_history password '…'"`, then the value in `.env`, then `docker compose up -d crypto-engine` (and `history history-backup` for the superuser's).
- Generate them like the other secrets (§1). They go into a URL as they are: keep them hex.
- Without its bot's password an engine's `HISTORY_URL` has none, and the history store refuses it: the engine keeps trading and retries every minute (§10).

### 3.7 The search accounts

Research's search accounts (§9):

| Variable | Section | Read by | What |
| --- | --- | --- | --- |
| `SEARCH_PROXY_URL` | SEARCH | `search` | The residential proxy (Evomi) for the paid search engine: `http://<user>:<password>_country-US@core-residential.evomi.com:1000`. Evomi's dashboard shows `host:port:user:password`, which doesn't work here. `_country-US` (an Evomi option, after the password) keeps the exits in the US. Percent-encode special characters in the password. Without it, the paid engine goes direct, and our IP is blocked by it. |
| `TAVILY_API_KEY` | SHARED | both engines | Tavily's search API, one key for both bots. Without it, research skips Tavily. |
| `EXA_API_KEY` | SHARED | both engines | Exa's search API, likewise. |
| `BRIGHTDATA_API_KEY` | SHARED | both engines | Bright Data's API key, likewise. |
| `BRIGHTDATA_ZONE` | SHARED | both engines | Bright Data's SERP zone; unset, `serp_api1`. |

- The proxy is billed per GB, and the search APIs have monthly allowances, so research uses them sparingly and paces them (§9).
- At start, `packages/wire/docker/searxng-start.sh` writes the proxy URL into a copy of the settings in the container's `/tmp`; the committed `searxng.yml` holds only a placeholder.
- After changing one, recreate whatever reads it: `docker compose up -d search` for the proxy, `docker compose up -d crypto-engine stock-engine` for the search APIs.

---

## 4. Build and start (first time)

```powershell
docker volume inspect cryptomarketbot_kraken-paper   # must exist: the paper wallet (§6)
docker compose config --quiet                       # checks compose.yml and .env; silent when fine
docker compose build                                # several minutes the first time
docker compose up -d                                # the engines, scraper, history, the backups, llm (the first start downloads its 12 GB model, §9)
docker compose ps                                   # engines "healthy" within ~90 s (crypto) / ~60 s (stock)
```

During the crypto build you should see the Kraken CLI download, its **checksum verified**, and `kraken 0.4.1` from the `RUN kraken --version` step. If the build stops there, the CLI can't run on the image.

Expected first log lines (`docker compose logs -f crypto-engine`, JSON), in this order:

1. `starting CryptoMarketBot engine` (stock: `starting StockMarketBot engine`)
2. `engine lease acquired`
3. `stream server listening` (port 8787 / 8788)
4. `engine running`

There should be no `"level":"error"` lines. Then run the checks in §5.3 and §5.4.

---

## 5. Everyday operations

### 5.1 Deploy

Run the gate on the commit you deploy first: `pnpm typecheck && pnpm test && pnpm lint && pnpm build` (see [AGENTS.md](../AGENTS.md)). Windows PowerShell 5.1 has no `&&`: run the four one by one there, or use Git Bash.

```powershell
git pull
docker compose up -d --build stock-engine      # rebuilds and recreates only the stock engine
docker compose up -d --build crypto-engine     # only the crypto engine
docker compose up -d --build scraper           # both bots' headless sources pause for a few seconds
docker compose up -d history history-backup    # the history store (engines buffer bars and retry meanwhile)
docker compose up -d llm                       # the local model server, after a change to its service (summaries pause ~1 min)
docker compose up -d search                    # the search service for local research (a few seconds)
docker compose up -d --build                   # everything whose image or config changed
```

- Naming the service is how you deploy one bot without touching the other. Shared code (`packages/*`) is compiled into each image at build time, so a change there reaches an engine only when that engine is rebuilt.
- **Stock**: any time, market hours included; pick a moment when the agent isn't in an episode (the Agent page's live feed shows no model call running). Stops rest at Alpaca; options exits wait for the engine, which is back in about a minute.
- **Crypto**: pick a moment when the agent isn't in an episode. Stops are watched only by the engine; it is back in about a minute.
- A stop is graceful (30 s grace period): the engine releases its lease, so the new container takes over at once.
- **History**: any time. While it's down the engines keep up to 50,000 bars each in memory and copy the news they missed when it's back; trading never waits for it.
- **llm**: any time. Recreating it reloads the model (~1 minute), during which the summaries back off and retry; trading never waits for it.
- **The host agent** isn't in compose: it is built and restarted on Windows (§11.3).
- Dashboards deploy by pushing to `main` (Vercel, §8).

### 5.2 Status, logs, restart

```powershell
docker compose ps                                          # every service and its health
docker compose logs -f --since 1h crypto-engine            # follow one engine
docker compose logs --since 24h stock-engine | Select-String '"level":"error"'
Get-Content logs\crypto-engine\2026-10-27.log -Tail 50 -Wait   # the history, across deploys (below)
Select-String '"level":"error"' logs\stock-engine\*.log    # every error in the kept history
docker compose restart stock-engine                        # same image, same env
docker compose up -d stock-engine                          # after editing a STOCK_ value in .env
docker compose stop crypto-engine                          # one engine; the other keeps running
docker compose start crypto-engine
docker stats --no-stream marketbots-crypto-engine marketbots-stock-engine marketbots-scraper
```

- Containers come back on their own after a crash or a reboot (`restart: unless-stopped`) once Docker Desktop is running. A container stopped by hand stays stopped across reboots.
- `docker compose down` stops and removes every container in the stack, both engines included. Volumes survive it. **Never add `-v`** (§6).
- Logs are JSON lines. Docker's copy is capped per container at 5 × 10 MB (scraper 3 × 10 MB), and it goes when the container is replaced, so at every deploy.
- The engines also append every line to `logs\<service>\<UTC date>.log` in the repo folder (`LOG_DIR`; git-ignored, on the Windows disk). A deploy, a Docker reset or a WSL reset leaves it alone: the new container carries on in the same day's file. Files older than 90 days are deleted, and a day's file stops at 25 MB (Docker's copy still gets every line). The scraper's logs are only in Docker's copy.

### 5.3 Health endpoints

```powershell
curl.exe http://127.0.0.1:8787/healthz     # {"ok":true}     liveness; the Docker healthcheck uses it
curl.exe http://127.0.0.1:8787/readyz      # {"ready":true}  200 once trading-ready, else 503 {"ready":false}
curl.exe http://127.0.0.1:8788/healthz
curl.exe http://127.0.0.1:8788/readyz
curl.exe https://engine.cryptomarketbot.app/healthz     # through Caddy, from any machine
curl.exe https://engine.stockmarketbot.app/healthz
```

The scraper publishes no port. Its health, from inside its container:

```powershell
docker compose exec scraper node -e "fetch('http://127.0.0.1:8790/health').then(r=>r.text()).then(console.log)"
```

The detailed view (every dependency, data freshness, AI calls) is each dashboard's **Admin → System**, fed by the engine's heartbeat. Every news source's health, with its errors when you're signed in, is on the dashboard's **News** page; Admin → System has a one-line summary.

### 5.4 After a deploy

- [ ] `docker compose ps` shows the engine `healthy`; `/readyz` says `{"ready":true}`.
- [ ] The logs show `engine lease acquired` and `engine running`, and no `"level":"error"` lines.
- [ ] Admin → System is green, and the news source count is about what it was before.
- [ ] The dashboard shows the engine *Running*, and the header's stream indicator ticks.
- [ ] Optional: *Pause* → *Paused* within ~3 s; *Resume* → *Running*.

### 5.5 Memory caps

The Docker VM has 15.5 GiB and the other stacks use ~3.5 GiB of it. Every service here is capped:

| Service | Limit | Expected |
| --- | --- | --- |
| `crypto-engine` | 1 GB | ~0.35 GB |
| `stock-engine` | 1 GB (was 768 MB: headroom at the open with ~1,500 tracked symbols) | 0.3–0.5 GB |
| `scraper` | 1 GB | 0.15 GB idle, up to 0.5 GB while rendering |
| `llm` | 6 GB RAM, 6 CPUs | ~2.5 GB at start, up to ~4.5 GB with its prompt cache (capped at 2 GB); ~6.8 GB of GPU memory on each card, always (§9) |
| `llm-model` | 256 MB | not running: only when you fetch a model file (§9), and removed when done |
| `search` | 512 MB | ~0.2 GB |
| `history` | 2 GB (`shared_buffers` 512 MB, tuned for that) | 0.6–1.2 GB, mostly cache |
| `history-backup` | 256 MB | a few MB; more for a minute at 10:30 UTC |

Check with `docker stats --no-stream` (§5.2).

### 5.6 Settings

Live trading settings (risk, AI models and timeouts, news engine, schedule) live in MongoDB and change only from the dashboard's **Admin** page, as an audited `settings.update` command. `.env` holds only first-boot defaults such as `STOCK_STARTING_CAPITAL`; changing those, or `DEFAULT_SETTINGS` in code, doesn't change a running bot.

### 5.7 Starting over

- **Crypto**: Admin → *Reset paper wallet*. It resets the CLI wallet and the books together. Don't delete the volume by hand: the books in MongoDB would no longer match.
- **Stock**: reset the paper account in the Alpaca dashboard. For a clean history, also drop the `stockmarketbot` database before restarting the engine.

---

## 6. The paper wallet volume

The crypto bot's Kraken CLI paper wallet (balances and trade journal) lives in the Docker volume `cryptomarketbot_kraken-paper`, mounted at `/data/kraken`. The old `cryptomarketbot` compose project created it, and `compose.yml` references it under its exact name:

```yaml
volumes:
  kraken-paper:
    external: true
    name: cryptomarketbot_kraken-paper
```

- **Never let compose create a new one.** Compose prefixes volume names with the project name: without `external`, this stack would create an empty `marketbots_kraken-paper`, and the engine would start a new wallet while the books in MongoDB have history (Discord alert: *Paper wallet was recreated*). With `external`, a missing volume stops compose with `external volume "cryptomarketbot_kraken-paper" not found` instead. Don't "fix" that by creating an empty volume: find out what happened, and restore a backup (§6.2).
- **Never point it at another database.** On a fresh database the engine resets the wallet to match (log: `paper workspace reset to match a fresh database`). `MONGODB_DB_NAME` stays `cryptomarketbot`; test images get a copy of the volume (§6.3).
- **Never remove it.** No `docker volume rm`, and no `down -v` in either project: in the old `cryptomarketbot` project it is a regular volume, so `docker compose -p cryptomarketbot down -v` would delete it.
- Copying it to a `marketbots_` name is optional cleanup for later.

Check that the engine has the right volume:

```powershell
docker inspect marketbots-crypto-engine --format '{{json .Mounts}}'   # "Name":"cryptomarketbot_kraken-paper", "Destination":"/data/kraken"
```

### 6.1 Look inside the wallet

```powershell
docker compose exec crypto-engine kraken --version
docker compose exec crypto-engine kraken workspace show cryptomarketbot -o json
docker compose exec crypto-engine kraken paper balance -o json
docker compose exec crypto-engine kraken paper history -o json
```

**Don't place manual trades in this workspace.** The engine imports them during reconciliation. To experiment by hand, use another workspace, e.g. `kraken paper buy BTCUSD 0.001 --workspace scratch`.

### 6.2 Back up and restore

The `wallet-backup` service backs the volume up automatically: once when it starts, then daily at 10:00 UTC, into `backups\kraken\kraken-paper-<UTC timestamp>.tgz` in the repo folder (git-ignored, on the Windows disk, so it survives a Docker or WSL reset). The newest 14 are kept. Check it with `docker logs marketbots-wallet-backup`. The wallet is small (a few KB).

An extra backup right now, e.g. before risky work: `docker compose restart wallet-backup`.

The CLI writes its journal during a trade, so a backup taken mid-trade could catch a half-written line. For a copy that is certainly consistent, run `docker compose stop crypto-engine` first, `docker compose restart wallet-backup`, then `docker compose start crypto-engine`.

Restore only as a last resort (the volume is gone or damaged). The wallet goes back to the backup's point while MongoDB keeps every later fill, so unless nothing traded since, expect *Books vs wallet: mismatch*; *Reset paper wallet* is the clean way out of that. From the repo folder:

```powershell
docker compose stop crypto-engine
docker volume create cryptomarketbot_kraken-paper      # only if it no longer exists
docker run --rm -v cryptomarketbot_kraken-paper:/data -v ${PWD}\backups\kraken:/backup busybox sh -c "rm -rf /data/* && tar xzf /backup/kraken-paper-<stamp>.tgz -C /data"
docker compose up -d crypto-engine
```

### 6.3 Boot-testing new images against a copy

`compose.smoke.yml` (project `marketbots-smoke`) boots the new engine images beside the live stack: a throwaway local MongoDB, its own history store in memory (databases `crypto_staging` and `stock_staging`), loopback ports 18787 and 18788, a **copy** of the wallet volume, fake Alpaca keys, and no AI, Discord, email or news keys. Use it before deploying a change to engine startup, a Dockerfile or `compose.yml`. Its header has the commands:

```powershell
docker compose build                                   # builds the images; running containers are not touched
docker compose -f compose.smoke.yml up -d
docker compose -f compose.smoke.yml logs -f crypto-engine
docker compose -f compose.smoke.yml down
docker volume rm marketbots-smoke_wallet
```

Never `down -v` there: that file also declares the live wallet volume (as `external`, but there is no reason to rely on that).

### 6.4 The history store's volume and backups

The history store (docs/plans/LOCAL-AI.md §6) keeps its data in the `marketbots_history-data` volume, inside Docker's disk on C:. A Docker or WSL reset loses it, and `down -v` would delete it, like the wallet.

- **What can be lost safely:** the 1-minute bars. The backfills fetch them again.
- **What can't:** the news archive (`news_items`, `news_triggers`). MongoDB deletes wire items after `wire.retention_days` (30), so the archive is the only copy of older news. `history-backup` dumps those two tables from both databases into `backups\history\<db>-<UTC timestamp>.sql.gz` in the repo folder (git-ignored, on the Windows disk): once when it starts, then daily at 10:30 UTC. The newest 7 per database are kept. Check it with `docker logs marketbots-history-backup`; an extra backup now: `docker compose restart history-backup`.

Look inside:

```powershell
docker compose exec history psql -U postgres -d crypto_history -c "select count(*), min(first_seen_at), max(first_seen_at) from news_items"
docker compose exec history psql -U postgres -d stock_history -c "select symbol, count(*), max(t) from bars_1m group by 1 order by 2 desc limit 10"
```

Restore the news archive into a fresh volume (the engines recreate everything else; stop the bot's engine first, so its first copy doesn't run while you restore):

```powershell
docker compose stop crypto-engine
docker compose up -d history                       # a new volume runs the init script: empty databases
docker compose exec history psql -U crypto_history -d crypto_history -c "select 1"   # wait until it answers
docker compose up -d crypto-engine                 # migrates (creates the tables), then copies what MongoDB still has
Get-Content backups\history\crypto_history-<stamp>.sql.gz -AsByteStream -Raw | docker compose exec -T history sh -c "gunzip | psql -U postgres -d crypto_history -v ON_ERROR_STOP=0"
```

The dumps hold only the rows, as `INSERT … ON CONFLICT DO NOTHING`: the tables must exist (the engine's migrations create them), rows the engine has already copied are skipped, and the older ones go in. Restoring a dump never touches the bars.

### 6.5 Kraken's history files (crypto backfill)

The crypto engine fills its history store from Kraken's downloadable OHLCVT history ([support article](https://support.kraken.com/hc/en-us/articles/360047124832)): every universe pair's 1-minute and daily bars since its first trade. They sit in `data\kraken-ohlcvt\` in the repo folder (git-ignored, on C:):

| Path | What |
| --- | --- |
| `Kraken_OHLCVT_Full.zip` | the full history, 9.5 GB, checked against Kraken's SHA-256 (the cut of 2026-10-06 runs to 2026-09-30) |
| `Kraken_OHLCVT_<year>Q<n>.zip` | a quarter's update |
| `altnames.txt` | the universe pairs' Kraken names (`XBTUSD`…), one per line |
| `csv\full\`, `csv\<year>Q<n>\` | each archive's `<altname>_1.csv` and `<altname>_1440.csv` for those pairs (2.4 GB), mounted read-only at `/data/ohlcvt` |

The engine runs three jobs, one step at a time, shown on Admin → System under *History store*:

- `kraken_files` imports every CSV once (resuming from its saved position after a restart);
- `kraken_gap` then rebuilds the minutes between the last file and the first live bar from the public Trades endpoint, one request every 4 s through the engine's own paced client (a few hours for 30 pairs);
- `kraken_daily` refreshes the daily bars from the OHLC endpoint every day.

**Adding a quarter** (Kraken publishes one a few days after it ends), or pairs added to the universe: download the zip, put the new pairs in `altnames.txt`, extract into `csv\<year>Q<n>\` (the command below does both archives; a pair missing from one is skipped), then `docker compose restart crypto-engine` so `kraken_files` picks up the new files.

```powershell
curl.exe -fLo data\kraken-ohlcvt\Kraken_OHLCVT_2026Q4.zip https://assets.kraken.com/marketing/institutions/Kraken_OHLCVT_2026Q4.zip
docker run --rm -v ${PWD}\data\kraken-ohlcvt:/in:ro -v ${PWD}\data\kraken-ohlcvt\csv:/out alpine:3.20 sh -c 'apk add -q unzip; f=""; for a in $(cat /in/altnames.txt); do f="$f ${a}_1.csv ${a}_1440.csv"; done; mkdir -p /out/2026Q4; unzip -qoj /in/Kraken_OHLCVT_2026Q4.zip $f -d /out/2026Q4; chmod -R a+rX /out'
```

The `chmod` matters: `unzip` restores the archive's modes (0600, owned by root), which the engine's non-root user can't read (`kraken_files` fails with `EACCES`).

### 6.6 Alpaca's history (stock backfill)

The stock engine fills its history store from Alpaca's SIP bars (all exchanges; the free plan serves them once they're 15 minutes old) with its own key, inside the engine: never run a second process with the live key (§1). Two jobs share one pacer, at most one request every 2 s (30 a minute, a fifth of the engine's REST budget):

- `alpaca_daily`: daily bars since 2016 for the scan universe (~1,500), the benchmarks, the index ETFs and holdings, 50 symbols a request (about 15 minutes); then once a day the last 10 days again, and the full history of any symbol new to the universe.
- `alpaca_minute`: 1-minute bars since 2016, extended hours included, for the top 300 of the scan universe by dollar volume plus the benchmarks and holdings, one symbol at a time (about two days); then once a day the last 3 days again, which replaces the live feed's IEX-only minutes with SIP's.

Both resume after a restart. Progress is on Admin → System under *History store*. Nothing to download by hand.

The archives can be deleted once extracted; the CSVs can be deleted once `kraken_files` is done (Admin → System), but the next quarter's import needs only its own folder anyway.

---

## 7. The swap from the old stacks

Both engines moved from their old compose projects (`stockmarketbot`, `cryptomarketbot`) to this stack on 2026-10-26, stock first. The procedure stays here for reference, and the rollback for as long as the old containers exist.

**Before:**
- The images are built (`docker compose build`) and boot-tested (§6.3).
- `.env.crypto` / `.env.stock` are filled in (the old server `.env` values, same names).
- No seed run is scheduled or running, and no cycle is running (Admin).
- **Stock**: a weekend or after 20:00 ET. Stops rest at Alpaca; options exits need the engine.
- **Crypto**: a quiet hour. Stops are watched only by the engine, but the swap takes a minute or two.
- Note the news source count on Admin → System.

**Steps** (stock shown; for crypto use `cryptomarketbot-*` and `crypto-engine`):

1. Stop the old engine and its scraper, and check that it is gone. While it runs, the new engine can't start anyway: the port is taken.

   ```powershell
   docker stop stockmarketbot-engine stockmarketbot-scraper
   docker ps --filter name=stockmarketbot              # nothing listed
   ```

2. Start the new engine and the shared scraper (once it runs, the second bot only needs its engine). Crypto mounts the **existing** wallet volume; check it first.

   ```powershell
   docker volume inspect cryptomarketbot_kraken-paper  # crypto only
   docker compose up -d stock-engine scraper
   ```

3. Verify:
   - `/healthz` and `/readyz` (§5.3).
   - `docker compose logs -f stock-engine` shows `engine lease acquired`. A clean stop releases the old lease; otherwise it lapses within 30 s.
   - **Crypto**: reconciliation is clean (Admin → System: *Books vs wallet: match*), and the mount check in §6 names `cryptomarketbot_kraken-paper`. **Stock**: order sync is clean and the positions match Alpaca.
   - The news source count is about the pre-swap count.
   - The dashboard shows the engine *Running* and the stream connects. No dashboard change is needed: same port, same proxy, same database.
4. Watch it for an hour, then for the rest of the day: memory, errors, triggers, AI calls.

**Afterwards:** remove the old scraper containers (`docker rm stockmarketbot-scraper cryptomarketbot-scraper`, done on 2026-10-26). Keep the old engine containers stopped, not removed, for 14 days (until 2026-11-09). They stay stopped across reboots.

Don't run `docker compose -p <old project> stop|start` from the marketbots folder: compose would load this folder's `compose.yml` under the old project name and can miss the old `engine` service. Use the container names as above, or run compose from the old repo's folder.

### Rollback

```powershell
docker compose stop stock-engine          # in the marketbots folder
docker start stockmarketbot-engine
```

For crypto: `docker compose stop crypto-engine`, then `docker start cryptomarketbot-engine`.

- Both use the same wallet volume. They no longer use the same database: the old containers still point at the old Atlas clusters, which stopped at the database move (below). Don't roll back to them since then.
- `docker start` brings the old container back with its original image and settings. The old engines were created without `SCRAPER_URL`, so they don't need the removed old scrapers.
- Use `docker start`, not `docker compose up` in the old folder: that would rebuild and recreate the old container from the old repo.
- Dashboards roll back with Vercel's instant rollback.

### Cleanup after 14 days (with owner approval)

```powershell
docker rm stockmarketbot-engine cryptomarketbot-engine
docker network rm stockmarketbot_default cryptomarketbot_default
docker image rm stockmarketbot-engine:latest stockmarketbot-scraper:latest cryptomarketbot-engine:latest cryptomarketbot-scraper:latest
```

**Never** remove `cryptomarketbot_kraken-paper`: it is still the live wallet.

### The database move (2026-10-28)

Until 2026-10-28 each bot had its own Atlas cluster: `cryptomarketbot` on the `cryptomarketbot` cluster, `stockmarketbot_v2` on the `stockmarketbot` cluster. Both moved to the one `marketbots` cluster, as databases `cryptomarketbot` and `stockmarketbot` (the stock one dropped its `_v2`).

- Per bot, with the engine stopped: `mongodump | mongorestore` (`mongo:8.0` image, `--nsFrom`/`--nsTo` for the rename), then a check that every collection's count, indexes and documents match. Only then did `.env.<bot>` switch, and the engine was recreated on the same image.
- The crypto engine must never boot against an empty or partial `cryptomarketbot`: a missing `accounts` document means fresh books, and the wallet is reset to match (§6).
The env files' rollback comments for this move were replaced at the move to Azure (below). What is left, with owner approval: delete the two old clusters in Atlas, together with the `marketbots` one.

### The move to Azure DocumentDB (2026-10-30)

On 2026-10-30 the three databases (`cryptomarketbot`, `stockmarketbot`, `serverstats`) moved from the Atlas `marketbots` cluster (the free tier, 512 MB, about 80 MB used) to an Azure DocumentDB free-tier cluster (32 GB), under the same names. No code changed: a probe against the new cluster passed every index both bots and the host agent create (TTL, partial, the unique partial one on open positions), duplicate-key code 11000 (the lease, the bus, the wire), transactions (Better Auth), pipeline updates, `$dateTrunc` and writes with `retryWrites` on.

- With both engines stopped (95 s): `mongodump` from Atlas into `backups\mongo-atlas-2026-10-30\` (`mongo:8.0` image), the Azure collections emptied, `mongorestore --noIndexRestore` into them, then a check that every collection's documents (each one compared) and indexes match. Only then did the env files switch and the engines restart. The host agent was restarted after them; the samples it wrote to Atlas meanwhile were copied over.
- **Restoring into the free tier:** `mongorestore`'s parallel index builds exhausted its connections (`TooManyLogicalSessions: The worker node connections have exceeded the limit`), and the aborted builds left index objects behind that made later builds fail (`NamespaceExists: relation "documents_rum_index_…" already exists`) until retried. So the collections and indexes were created once, one index at a time with retries, and the move only refilled documents: `--noIndexRestore`, `--numParallelCollections=1`, `--numInsertionWorkersPerCollection=1`.
- `.env` keeps the Atlas `MONGODB_URI` as a comment under the live one until the cleanup (the three env files of the time became the one `.env` later that day, §3); the originals are in `backups\mongo-atlas-2026-10-30\env\`.

**Rollback** (only soon after the move: anything written since is only on Azure, and crypto's books would no longer match the wallet): swap the commented `MONGODB_URI` in `.env` with the live one, `docker compose up -d --no-deps --force-recreate crypto-engine stock-engine`, restart the host agent (§11.3), and set both Vercel projects' `MONGODB_URI` back.

**Cleanup after 14 days** (with owner approval, from 2026-11-13): delete the commented line from `.env`, delete the Atlas clusters, and delete `backups\mongo-atlas-2026-10-30\`.

---

## 8. Vercel

Three Vercel projects build from `colinfran/marketbots`, on the Hobby plan of the `colinfran` team:

| Project | Root Directory | Domain |
|---|---|---|
| `cryptomarketbot` | `apps/crypto-web` | cryptomarketbot.app |
| `stockmarketbot` | `apps/stock-web` | stockmarketbot.app |
| `marketbots` | `apps/landing` | marketbots.vercel.app |

The two dashboards are the same projects as before the merge, with the same domains, env vars and auth.

### 8.1 Project settings

In each project:

1. *Settings → Build and Deployment*:
   - **Root Directory**: as in the table above.
   - **Include files outside the root directory in the Build Step**: on. The apps import `packages/*`.
   - **Skip deployments when there are no changes to the root directory or its dependencies**: on (§8.2).
   - **Node.js Version**: 24.x.
   - Framework Next.js; install and build commands default (pnpm is detected from the root lockfile).
2. *Settings → Git*: repo `colinfran/marketbots`, production branch `main`. No custom Ignored Build Step.

After a deploy, check that you can sign in, the stream connects, and a *Pause* / *Resume* round trip works. The old repos no longer deploy anything and can be archived (read-only).

### 8.2 Skipping unaffected builds

So that a push touching only one bot doesn't rebuild the other bot's dashboard. Vercel reads the pnpm workspace: a project builds when a commit changes its Root Directory or a workspace package it depends on (its `package.json`, followed through the packages' own dependencies). Otherwise the commit shows *Skipped - Not affected*.

- A new shared package is covered once it's in the app's `dependencies`; there's no list to update.
- Commits that touch only the engines, `docs/` or `contracts/` build nothing.

### 8.3 Bad deploys

Vercel's instant rollback (*Deployments* → a previous deployment → *Instant Rollback*). Only the last few deployments are kept (§8.4); to go further back, redeploy an older commit.

### 8.4 Deployment storage

Every deployment Vercel keeps holds its own copy of the dashboard's server code (*Functions Storage*). The Hobby plan caps that at 10 GB for the whole team, all projects together, and going over can block deploys. With the default 30-day retention, a busy month of pushes fills it: on 2026-10-30 the team had ~400 kept deployments, ~300 of them these three projects'.

- **Retention** (*Team Settings → Security & Privacy → Deployment Retention Policy*, applied to all existing projects): the shortest periods. Vercel still keeps each project's last 3 production deployments, so rollback works.
- **Clean-up by hand**, if usage is high again: delete all but the live deployment and the two before it. Each project's *Deployments* page does it, or the CLI (`npx vercel login` first):

  ```powershell
  npx vercel list cryptomarketbot                  # newest first
  npx vercel rm <deployment id> ... --safe --yes   # --safe skips anything on a domain
  ```

  Deleted deployments can be restored for a while from the project's *Settings → Security → Recently Deleted*.
- Usage is counted in GB-months, so the figure on *Usage* can stay high until the billing period resets, even after a clean-up.

---

## 9. The local model server (`llm`)

`llm` is llama.cpp's server running **Qwen 3.6 35B-A3B at 2-bit**: Unsloth's `UD-Q2_K_XL`, 12.3 GB. It is split across both GPUs and loaded at all times. [LOCAL-AI.md §5.1](plans/LOCAL-AI.md#51-step-0-results-2026-102728) has the measurements behind the choice.

- **Access:** both engines reach it at `LLM_URL=http://llm:8080`, an OpenAI-compatible API, over the `ai` network. It has no host port and no internet.
- **Work:** every AI call: the research memos and decisions of both bots (below), each bot's agent (one episode at a time per bot, a few short steps each: [plans/LOCAL-AI.md §8](plans/LOCAL-AI.md#8-the-agent)), and the article summaries.
- **When it's down:** the engines keep protecting positions (stops and targets run in code), but make no new decisions: research and decisions fail. The summaries stop too, and the source `enrich:summaries` turns degraded on the dashboard.

**The model file:** `llm-model` fetches it, and runs only when you ask (it's in the `setup` profile, so `docker compose up` skips it and no stopped container sits in the stack):
- It downloads the file from Hugging Face, at a pinned commit, into the `marketbots_models` volume.
- It checks the file's SHA-256 and removes a download that fails the check.
- Once checked, the file is kept: running it again only confirms it ("have …").
- Run it on a new server, after a Docker or WSL reset, and after changing the model, before `llm` starts. Without the file, `llm` exits at start.

```powershell
docker compose --profile setup run --rm llm-model           # "have …", or the download and its check
```

To change the model, edit `llm-model`'s `MODEL_URL`, `MODEL_FILE` and `MODEL_SHA256`, and `llm`'s `--model` and `--alias`, in `compose.yml`. Run `llm-model` as above, then `docker compose up -d llm`. A new alias also goes into Admin's model dropdowns (`AI_MODELS` in `packages/ui/src/lib/settings-fields.ts`), as `local/<alias>`. The server's image is pinned by digest.

**How summaries are used:**
- **Which items:** news cluster roots at severity ≥ `wire.summaries.min_severity` (Admin), and never on the trigger path.
- **Which model:** whichever the server serves. Its alias (`qwen3.6-35b-a3b-q2`) is recorded on each summary. Summaries don't think: each request turns thinking off.
- **Where they show:** under the item on the News page.
- **In prompts:** the AI's wire dossier carries the summaries of its 8 best-ranked items. Each is labelled as a machine summary, and the AI is told to cite the item's URL, never the summary.
- **Turning them off:** set `wire.summaries.enabled` to off in Admin.

**Requirements:** both NVIDIA GPUs, the Windows NVIDIA driver, and Docker Desktop's WSL2 backend, which passes the GPUs to containers (Jellyfin already uses the 3070 that way).

```powershell
docker compose up -d llm                                    # needs the model file (llm-model, above)
docker compose ps llm                                       # "healthy" once the model is loaded (~1 min)
docker exec marketbots-llm curl -s localhost:8080/v1/models # the alias: qwen3.6-35b-a3b-q2
docker exec marketbots-llm curl -s localhost:8080/metrics   # tokens and requests so far
nvidia-smi                                                  # ~6.8 GB used on each card
```

**Setup:**
- **The GPUs:** picked by UUID in `CUDA_VISIBLE_DEVICES`, the 2080 SUPER first. Windows and WSL can number the cards differently. After swapping a card, update the UUIDs (`nvidia-smi -L`).
- **Placement:** `--fit on --fit-target 512,1024` places the layers so 512 MB stays free on the 2080 SUPER and 1 GB on the 3070, for the display and a Jellyfin transcode. With this model, nothing needs to go to system RAM.
- **Slots:** three, one per bot and one for news. They share one 96k-token KV cache (`q8_0`), with flash attention on.
- **Loading:** `--load-mode none` reads the whole file at load. Memory-mapped experts were paged in slowly on first use.
- **Cold starts:** the first start compiles the CUDA kernels (2–3 minutes) and keeps them in the `llm-cache` volume. Later starts take ~1 minute.

**Caps:**
- **Container:** `mem_limit: 6g` (it holds ~2.5 GB, plus up to 2 GB of prompt cache), `cpus: 6`. llama.cpp's 6 threads spin while they wait, so a 4-CPU cap throttled them: 36–40 tokens/s against 45–46 at 6. Idle, it uses next to no CPU.
- **Prompt cache:** `--cache-ram 2048`. llama.cpp keeps recent prompts in RAM so a new request can reuse their start, 8 GB by default: more than the container's 6 GB. At the default, the container sat at its cap and swapped 3.6 GB (all of the Docker VM's swap), and the whole VM froze for seconds when a request needed it back: other containers stalled too (the system monitor showed gaps), and a request was cancelled. Keep the cache well under the container's cap.
- **GPU:** ~6.8 GB on each card.
- **Power:** the 2080 SUPER is capped at 180 W (§2).

**The agent** (`@mb/agent/client`; the agent's *Model* in Admin, `local/<alias>`, the only kind of model id settings accept): each step of an episode is one streamed chat completion, constrained by a JSON schema, on the bot's slot.
- **Cost:** none. Every call is in `ai_calls` with `cost_usd: 0` and `cost_source: "local"`, with its tokens and time.
- **Thinking:** per priority, `agent.limits.pN.thinking_tokens` in Admin: none for P0 and P1 by default (fast answers to price moves and the owner), 1,024 for P2 and 2,048 for P3. 0 turns it off.
- **The live model feed:** every call's thinking and output stream to the dashboards' live feed (`llm.call`, then `llm.delta` once a second, then `llm.done`), with the server's slots every second while someone is watching (`llm.status`, from `/slots`). The thinking is owner-only unless `agent.public_thinking` is on.
- **Without LLM_URL:** no AI at all. The engine still protects positions, but opens nothing new.

**Research** (`@mb/wire/research/local`, the agent's `research` tool, offered to P2 and P3 episodes only): the model can't browse, so the engine does the browsing for it, for one question:
1. The model reads the request and writes up to 6 web searches (no thinking).
2. They run two at a time, for results from the last week, on the `search` service's free news engines only. The agent's research never uses the metered providers or the paid engine (below); nothing else calls research since the timed cycles were removed.
3. The model picks up to 5 results to read in full, and the scraper fetches them (paywalled sites are refused, as for summaries).
4. The model writes the memo from the results and articles alone, citing their URLs.

A run takes about a minute, and costs nothing (`ai_calls`: `cost_source: "local"`, the searches counted). Its limits:
- **Time:** the tool gets what the episode has left, 45 s to 3 minutes (with less it tells the agent to answer from what it has). The memo gets what the searches and reading leave. It keeps ~40 s for reading and writing (~1,200 tokens), thinks only with the rest (up to 1,024 tokens, which needs ~66 s), and is capped at what the time left can write at 40 tokens/s. A short time gets a shorter memo without thinking, not a timeout.
- **No X.** The memo says so, rather than guessing at sentiment.
- **No paywalled articles.** Their search snippets can still be cited.
- **A search that finds nothing** is reported in the memo, and the agent decides from our feeds. Only an unreachable search service or model fails the research.

**The search service (`search`):** SearXNG, pinned by digest, on the default network (it needs the internet), with no host port. The engines reach it at `SEARCH_URL=http://search:8080`. Its settings are `packages/wire/docker/searxng.yml`: only the four engines research uses, JSON answers, no rate limiter (only the engines call it). `searxng-start.sh` starts it with a random secret key (it keeps no sessions) and the proxy's URL (§3.7).
- **Free engines** answer from our own IP: DuckDuckGo News, Yahoo News and Bing News. Bing News filters by date itself. The other two can't, so SearXNG would skip them on a dated search: they're asked without a date, and only results dated since the research's start date are kept.
- **The paid engine**, Google CSE, blocks our IP ("unusual traffic"), so it goes through the residential proxy (Evomi, US home IPs). The proxy is billed per GB, so the engine is disabled in SearXNG (only a request that names it runs it), and research names it only for a search the free engines found fewer than 3 results for: at most 100 a UTC day per engine (`PAID_SEARCHES_PER_DAY`). It's asked for 8 results, all research reads. Each paid search is logged (`local research: a paid search`).
- **Its cost**, measured through the proxy on 2026-10-29: ~11 KB a search, plus ~8 KB for Google's search token at most once an hour, and ~5 KB to open a new tunnel. Even at the cap on both engines (200 a day) that's under 4 MB a day, ~110 MB a month. Evomi's dashboard shows the real use.
- **Blocks:** SearXNG suspends a blocked engine for 3–30 minutes (`suspended_times`), not the hours or days of its defaults: the proxy's next tunnel leaves from another IP.
- **Not used:** Brave (rate-limited even through the proxy, and its refusal page is 81 KB), DuckDuckGo's web search (CAPTCHAs after two searches through one exit), Mojeek and Startpage (proof-of-work CAPTCHAs, off upstream), Google News and Qwant (access denied), Reuters (401).
- **Check it:** `docker compose ps search`, and `docker logs marketbots-search` for engines that fail.
- **When research runs:** Admin's *Web research* (auto: only when our feeds leave a gap) and *Event research* (*web check*: a quick search before an event decision; stored as `x_verify`).

**Metered providers** (`@mb/wire/research/metered`; keys in `.env`'s SHARED section, §3.7): search APIs with a free monthly allowance. The engines call them directly, not through `search`, in this order, for a search still short of 3 results:

| Provider | Free allowance | A search | Per day, both bots (31-day month) | Per bot |
| --- | --- | --- | --- | --- |
| Tavily | 1,000 credits a calendar month | 1 credit (basic, up to 8 results, dated); ~1.5 s | 32 | 16 |
| Exa | $10 of credit a calendar month | ~$0.007 (`auto`, up to 8 results with highlights, dated); ~1.3 s | $0.32 | $0.16 (~23 searches) |
| Bright Data | 5,000 requests a calendar month (SERP zone `serp_api1`) | 1 request (Google, ~9 results, dated relatively); 10–14 s, sometimes failing | 161 | 80 |

- **Pacing:** each day of a UTC month adds an equal share of the month's allowance (rounded down for whole searches), and a share left unused carries over to later days. Both bots use the same accounts, so each keeps to half the allowance so far by its own spend. Each bot stores that spend in its `search_usage` collection (one document a month), so a restart doesn't reset it.
- **Tavily** also checks Tavily's own count of the account (its usage endpoint, read at most every 5 minutes), which covers both bots and any other use of the key. That count lags by minutes or more (still 0 seven minutes after a search on 2026-10-29), so a new reading never lowers the count below an engine's own. A refusal for lack of credits (432) stops Tavily until the next reading.
- **Exa** is paced in dollars: a search is reserved at $0.007 and settled at the cost Exa reports (`costDollars`).
- **Bright Data** asks Google for the research's window (`tbs=qdr:d/w/m`) through the SERP zone (`BRIGHTDATA_ZONE`, default `serp_api1`; the free MCP zone `mcp_unlocker` isn't on the account). It comes last because it's slow: on 2026-10-29 searches took 10–14 s, and some failed after 2–25 s ("redirect location was rejected"; Bright Data answers those 200, with the reason in `x-brd-error`). Google dates its results relatively ("9 hours ago"), and research turns those into times.
- **Logs:** each search is logged as `local research: a metered search`, with the provider and this bot's spend on it this month.

**The speed guard:** llama.cpp doesn't report where its tensors sit, so the engines judge by speed. A summary written slower than 20 tokens/s pauses summaries for 30 minutes. Normal is 40–50 tokens/s, less per request while other slots run. A model spilled into system RAM writes 15–20.

**Leftovers:** Ollama's `marketbots_ollama-models` volume (~2 GB, `llama3.2:3b`) is no longer used. `marketbots_models` also holds the step-0 candidates beside the model in use. Delete either only on purpose: `docker volume rm` can't be undone.

---

## 10. Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| `Invalid engine environment` for every variable, `MONGODB_URI` first | No `.env` at the repo root, or compose was run from another folder: compose reads `.env` from the project folder (§3.3). |
| `external volume "cryptomarketbot_kraken-paper" not found` | The wallet volume is missing. Don't create an empty one on this server: check `docker volume ls`, then restore a backup (§6.2). |
| `port is already allocated` on `docker compose up` | Another container holds 8787/8788, usually an old engine (`docker ps`). Stop it. Don't move the port: Caddy targets it. |
| `Invalid engine environment` in logs | A required variable is missing or too short (secrets need 32+ characters). Fix it in `.env` (the bot's names have its prefix there), then `docker compose up -d <bot>-engine`. |
| `MongoDB connection failed; retrying` | The cluster's firewall (Azure portal → the cluster → *Networking*) doesn't allow the server's IP, or the URI/password is wrong (a `$` in it: §3.3). |
| `another engine holds the lease; waiting for it to expire` | Another engine is on the same database: an old container (`docker ps`), or a local dev engine without a `_dev` database (§3.5). |
| `Kraken CLI paper wallet unavailable` | Run the §6.1 commands to see the CLI's own error. No orders are placed until it works (retried every minute). |
| Admin → System: *Books vs wallet: mismatch* | Something traded the workspace outside the engine, or a fill was lost. New entries are blocked. The owner view lists the differences; *Reset paper wallet* clears it. |
| Alert *Paper wallet was recreated* | The engine found an empty wallet while the books have history: the volume was lost or a new one was created. Stop `crypto-engine`, check the mount (§6), restore a backup or reset the wallet. |
| Log `paper workspace reset to match a fresh database` | The crypto engine started against a new database (wrong `MONGODB_DB_NAME`?) and reset the wallet. Fix the name; the previous wallet state is gone unless you have a backup. |
| Stock: Admin → Alpaca REST *down*, 401s in logs | Wrong or old paper keys (a reset can issue new ones). |
| Stock: `406 connection limit exceeded` on market data | Something else uses the account's one data connection: another script, a notebook, a local engine with the live keys. The engine retries every minute. |
| Stock: `405 symbol limit exceeded` | Lower *Live price subscriptions* in Admin → Settings (the free plan allows 30). |
| Stock: spreads rejected by the broker | Options level below 3: raise it in Alpaca or turn spreads off in Settings. |
| Headless news sources down in Admin | The scraper isn't running or is unhealthy: `docker compose ps scraper`, `docker compose logs scraper`, the health check in §5.3. |
| Header says "No stream" | `ENGINE_STREAM_URL` isn't set on Vercel (redeploy after adding it). |
| Stream stuck on "reconnecting" | Caddy isn't running or lacks the site, `STREAM_ALLOWED_ORIGINS` doesn't include the exact dashboard origin (handshake refused), or `STREAM_TOKEN_SECRET` differs between Vercel and the engine (connection closed with 4003). |
| "Owner sign-in is not configured" | `BETTER_AUTH_SECRET` (32+ characters), `MONGODB_URI` or `OWNER_EMAIL` is missing on Vercel. |
| No sign-in email arrives | `USESEND_API_KEY`, `USESEND_BASE_URL` or `USESEND_FROM_EMAIL` is missing or wrong, or the sender domain isn't verified in useSend (Vercel function logs show the error). Only `OWNER_EMAIL` is ever emailed. |
| Vercel skips a build that changed a dashboard | The change was outside the app and its workspace dependencies, e.g. a package the app imports without listing it in `package.json` (§8.2). List it, or redeploy by hand. |
| A deploy is blocked for storage, or *Functions Storage* is near 10 GB | Too many kept deployments (§8.4). |
| Vercel build can't resolve `@mb/...` | *Include files outside the root directory* is off (§8.1). |
| `llm` won't start: `could not select device driver "nvidia"` | Docker can't see the GPUs: update the NVIDIA driver and Docker Desktop, and check the WSL2 backend is on. |
| `llm` exits at start with `cudaMalloc failed: out of memory` | Something else holds GPU memory (a game, a second model server, a big transcode). Free it, then `docker compose up -d llm`. |
| `llm` exits at start: the model file can't be opened | The file isn't in the `marketbots_models` volume (a new server, a Docker or WSL reset, a new model). Fetch it with `docker compose --profile setup run --rm llm-model`, then `docker compose up -d llm`. |
| `llm-model` ends with `SHA-256 mismatch` | The download is corrupt or the pinned file changed. It was removed; run `llm-model` again to download it again. |
| *enrich:summaries* degraded: `… wrote 12.3 tokens/s (floor 20): paused for 30 min` | The model ran slowly: spilled into system RAM, or the GPUs are busy with something else. Summaries resume by themselves after 30 minutes; check `nvidia-smi`. |
| *enrich:summaries* degraded: `GET /v1/models failed (503)` | The server is still loading the model (~1 minute after a start). |
| `initdb: CRYPTO_HISTORY_PASSWORD is not set` on the first start of `history` | `HISTORY_CRYPTO_PASSWORD` (or the stock one) is missing from `.env` (§3.6). |
| Admin → System: *History store: unreachable*, log `history store unavailable; retrying in a minute` | `docker compose ps history`: not running, or still starting. A `password authentication failed` means the bot's `HISTORY_<BOT>_PASSWORD` in `.env` doesn't match the role's password (§3.6). The engine keeps trading and retries every minute. |
| *History store* shows bars *dropped* | It was down long enough for an engine's 50,000-bar buffer to fill. The backfills can fetch those minutes again. |
| `history-backup` logs `backup of … failed (no news archive yet?)` | Normal until the engine has migrated its database; otherwise check `docker compose logs history`. |

---

## 11. The host agent (Admin → Server)

Admin → Server, the same in both dashboards, shows the Windows machine itself: the CPU (load per thread, package temperature, clock, power), both GPUs, memory, the motherboard fans, the volumes and disk rates, the outlet's power and the electricity it measured, with 30 days of history. It also runs the motherboard fans. It replaces the Jellyfin System Monitor (`C:\JellyfinDocker\apps\SystemMonitor`), removed with Jellyfin; its history was imported (§11.6).

The containers can't read any of this (they see the Docker VM), so it runs on Windows:

| What | Where | Started by |
| --- | --- | --- |
| LibreHardwareMonitor 0.9.6 | `apps\host-agent\data\LibreHardwareMonitor`. Its sensor server listens on 127.0.0.1:8086 behind a generated password (`data\lhm.json`); firewall rule `marketbots-host-sensors-block` blocks the port from the network | `\marketbots\Host sensors` at sign-in, elevated (its PawnIO driver reads and sets the board) |
| The host agent | `apps\host-agent\dist\main.js` on the server's own Node, with `.env` | `\marketbots\Host agent` at startup, no window; restarted if it exits |
| The fan watchdog | `dist\fan-watchdog.js`, a detached process the agent starts | the agent, when `FAN_CONTROL=on` |

Every reading (2 s by default) the agent reads Windows, `nvidia-smi` and LibreHardwareMonitor; the VeSync outlet once a minute. It writes into its own database on the bots' cluster, `serverstats` (`HOST_DATABASES`), which both dashboards read (`HOST_DB_NAME`): it is one machine, so one copy.

- `host_status`: the latest reading. The page polls it every 2 seconds and shows a reading older than 15 seconds as offline, never as current.
- `host_samples`: every reading, kept a little over an hour, and minute averages with the energy measured in each minute, kept 30 days (TTL). About 20 MB.
- `host_commands`: the owner's fan setting, agent settings and outlet discovery, from either dashboard. Audited like the engines' commands (the request in the sending bot's audit log, the outcome in `serverstats.audit_log`); one not picked up within 2 minutes is rejected unapplied.

Nothing in it touches the bots' databases or trading state, and the engines don't know it exists.

### 11.1 Its variables

The agent reads the repo's `.env` (§3), started with `node --env-file`: the SHARED section's `MONGODB_URI` and the HOST section, under their own names. It ignores the bots' variables in the file. Nothing in the HOST section goes to Vercel.

| Variable | What |
| --- | --- |
| `MONGODB_URI` | The bots' cluster (SHARED) |
| `HOST_DATABASES` | Optional: its database (default `serverstats`; the dashboards' `HOST_DB_NAME` must match) |
| `FAN_CONTROL` | `on`: the agent sets the motherboard fans. `off` (default): it only reads them (§11.4) |
| `VESYNC_USERNAME`, `VESYNC_PASSWORD` | A VeSync account that sees the outlet: a separate one the home or outlet is shared with (accept the share in the VeSync app, signed in as it). Without them, no power or energy readings (the recorded history still shows) |
| `VESYNC_TIMEZONE`, `VESYNC_COUNTRY_CODE`, `VESYNC_REFRESH_MS` | Optional: the account's time zone (default the server's) and country (`US`), and how often the outlet is read (60000 ms) |
| `HOST_DATA_DIR`, `LHM_CONNECTION_FILE` | Optional: where the agent keeps its files (`apps\host-agent\data`) and LibreHardwareMonitor's login (`<data>\lhm.json`) |

The agent's own settings (the reading interval, the electricity price and currency, the outlet) aren't in the file: they change in Admin → Server → Settings and are kept in `data\settings.json`. After editing its variables in `.env`, restart the agent (§11.3).

### 11.2 First install

```powershell
notepad .env                                             # MONGODB_URI (SHARED), the HOST section: the VeSync login (.env exists from §2)
pnpm install
pnpm --filter @mb/host-agent build
.\apps\host-agent\scripts\install-sensors.ps1            # administrator PowerShell
.\apps\host-agent\scripts\install-tasks.ps1              # administrator PowerShell, as the account that signs in
Start-ScheduledTask -TaskPath '\marketbots\' -TaskName 'Host sensors'   # approve the PawnIO driver prompt the first time
Start-ScheduledTask -TaskPath '\marketbots\' -TaskName 'Host agent'
Get-Content apps\host-agent\data\logs\agent.log -Tail 20
```

The sensors run only after sign-in (LibreHardwareMonitor is a desktop app); before that the agent reports without the motherboard sensors, and the BIOS runs the fans.

### 11.3 Deploy, restart, logs

```powershell
pnpm --filter @mb/host-agent build
Stop-ScheduledTask -TaskPath '\marketbots\' -TaskName 'Host agent'     # the watchdog hands the fans to the BIOS
Start-ScheduledTask -TaskPath '\marketbots\' -TaskName 'Host agent'    # the saved fan setting is back within seconds
Get-Content apps\host-agent\data\logs\agent.log -Tail 50 -Wait          # JSON lines; rolls over to agent.log.1 at 10 MB
Get-ScheduledTask -TaskPath '\marketbots\' | Get-ScheduledTaskInfo      # last run and result of both tasks
```

Any time is fine: the engines don't depend on it. The page itself deploys with the dashboards (push to `main`).

The task's command line names the env file. Tasks registered before the move to one `.env` (2026-10-30) start the agent with `.env.host`: run `install-tasks.ps1` again once (administrator PowerShell, as the account that signs in), then restart the agent as above.

### 11.4 Fans

One setting for every motherboard CPU/case fan with RPM feedback (never the GPUs' own fans, never a header named like a pump):

- **Automatic cooling**: follows the CPU package temperature: 30 °C → 40%, 45 → 50%, 60 → 65%, 75 → 85%, 85 → 100%, interpolated.
- **Manual speed**: one speed, 40–100%.
- **BIOS control**: the motherboard's own curve.

In every mode but BIOS, every fan runs at 100% at 85 °C, without a CPU temperature, or when a controlled fan stops reporting RPM. Speeds go up at once and come down at most 5 points every 2 seconds. Before each write the agent tells the watchdog which headers it holds. If the agent exits or stops heartbeating for 8 seconds, the watchdog hands them back to the BIOS, retrying every second. The setting and its headers are saved in `data\fan-settings.json` and reapplied when the agent starts; with no saved setting, the BIOS keeps control.

- **Never run two fan controllers.** `FAN_CONTROL=on` only when nothing else sets the fans: not the old System Monitor, not a vendor utility, not LibreHardwareMonitor's own fan controls.
- This is best effort, not a replacement for the BIOS's thermal protection: keep a sane BIOS curve. Nothing in software helps while Windows or LibreHardwareMonitor is down.
- A pump on a header with a generic name can't be told from a fan: don't enable fan control with one.

### 11.5 Switching over from the Jellyfin System Monitor (once)

Its Windows agent held fans #1, #2 and #5 at manual 100%. On 2026-10-30 its agent was stopped (its watchdog handed the fans to the BIOS) and `data\fan-settings.json` was seeded with that setting; the agent's fan control was checked on the board (taking the fans to 100%, and handing them back when killed). What is left, from an administrator PowerShell at the repo root:

```powershell
Disable-ScheduledTask -TaskName JellyfinSystemMonitor
Disable-ScheduledTask -TaskName JellyfinSystemMonitorSensors
Stop-ScheduledTask -TaskName JellyfinSystemMonitorSensors
Get-Process LibreHardwareMonitor -ErrorAction SilentlyContinue | Stop-Process     # the old one; the BIOS keeps the fans
.\apps\host-agent\scripts\install-sensors.ps1
.\apps\host-agent\scripts\install-tasks.ps1
Start-ScheduledTask -TaskPath '\marketbots\' -TaskName 'Host sensors'           # approve the PawnIO prompt
Start-ScheduledTask -TaskPath '\marketbots\' -TaskName 'Host agent'             # restores manual 100% within seconds
```

Then check Admin → Server: the fans at 100% under *Motherboard fans*, and *Manual speed* under *Cooling*.

### 11.6 The imported history

The old monitor's data folder was copied out of its Docker volume (`jellyfin-system-monitor-data`) into `backups\jellyfin-system-monitor\` on 2026-10-30: `history.sqlite` (2-second readings from 2026-10-17) and `settings.json` (the price, currency and outlet, which became the agent's settings). It was imported as minute samples into `serverstats`:

```powershell
cd apps\host-agent
node --env-file=..\..\.env dist\import-history.js ..\..\backups\jellyfin-system-monitor
```

The import matches the old monitor's own energy totals to the watt-hour. Running it again only fills minutes that are missing; `--replace` rewrites an earlier import's minutes. The imported minutes leave the charts as they turn 30 days old, by 2026-11-29; after that the backup can be deleted.

### 11.7 Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| *The host agent has never reported* | The `Host agent` task isn't running or can't reach the database: `Get-ScheduledTask -TaskPath '\marketbots\' \| Get-ScheduledTaskInfo`, then the log (§11.3). A bad `.env` stops it at start: the task's last result is 1. |
| *Offline* with a time | The agent stopped or lost the database after that reading. The history stays. |
| *Motherboard sensors: LibreHardwareMonitor is not responding* | The `Host sensors` task isn't running, or the PawnIO prompt wasn't approved: run `start-sensors.ps1` by hand. |
| No CPU temperature, every fan at 100% | *Cooling protection*: LibreHardwareMonitor has no `CPU Package` temperature (sensors still loading, or the driver isn't approved). |
| *Fan control is off on the server* | `FAN_CONTROL=off` in `.env` (§11.4). |
| *The fan watchdog stopped* | Fan control is off until the agent restarts (§11.3). |
| *VeSync login failed*, *Several outlets found* | Check the account and region in `.env`; pick the outlet in Settings after *Discover*. |
| *VeSync lists no devices on this account* | The account logs in but sees no outlet: accept the home (or outlet) share in the VeSync app, signed in as that account. |
| VeSync: `login temporary auth code expired` | Since 2026-10-26 VeSync completes logins only for its own app's ID, which the agent sends (`VESYNC_APP_ID` in `vesync.ts`); if VeSync changes it again, update it there. |
