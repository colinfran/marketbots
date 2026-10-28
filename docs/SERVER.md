# Server setup and operations

How the `marketbots` Docker stack runs on the Windows server: first-time setup, the env files, everyday commands, the paper wallet volume, the swap from the old stacks, the Vercel projects, the local LLM and troubleshooting. Commands are for **PowerShell** on the server, run from the repo root (`C:\Users\colin\Documents\GitHub\marketbots`) unless noted.

This replaces both old `docs/WINDOWS_SERVER_SETUP.md` guides (cryptomarketbot and stockmarketbot). How the pieces fit together: [ARCHITECTURE.md](ARCHITECTURE.md).

What runs where:

| Where | What | Config |
| --- | --- | --- |
| Windows server, Docker stack `marketbots` | `crypto-engine` on 127.0.0.1:8787 (with the Kraken CLI paper wallet), `stock-engine` on 127.0.0.1:8788, `scraper` (no host port), `llm` and `llm-model` (llama.cpp with the local model on both GPUs, no host port), `history` (Postgres with TimescaleDB and pgvector, no host port) and `history-backup` | `compose.yml`, `.env.crypto`, `.env.stock`, `.env.history` at the repo root |
| Caddy on the Windows host | `engine.cryptomarketbot.app` → 127.0.0.1:8787, `engine.stockmarketbot.app` → 127.0.0.1:8788 (WebSocket) | `C:\Caddy\Caddyfile` |
| Vercel | two projects: `apps/crypto-web` at cryptomarketbot.app, `apps/stock-web` at stockmarketbot.app | each project's environment variables |
| MongoDB Atlas | one cluster, databases `cryptomarketbot` and `stockmarketbot` | `MONGODB_URI` |
| Alpaca | the stock bot's paper account | `.env.stock` (engine only) |

The two engines are independent: separate images, containers, ports, env files, databases, leases and stream secrets. Deploying, restarting or crashing one never touches the other. At runtime they share only the scraper, the LLM, the history service (each with its own database and role on it) and the server's IP address.

---

## 1. Accounts and secrets (once)

**MongoDB Atlas**: one cluster serves both bots, each in its own database.
1. *Database Access*: a user with read/write access.
2. *Network Access*: the server's public IP, plus `0.0.0.0/0` for Vercel (it connects from changing IPs; the strong password is the protection).
3. *Connect → Drivers*: copy the `mongodb+srv://…` string.

**Alpaca (stock)**: the paper account, reset to **10,000**. Total return is measured from $10,000 and every P&L number comes from Alpaca, so the account belongs to this bot alone. A reset can issue new keys. Debit spreads need **options level 3** (Admin shows the level the engine sees). Alpaca's free market-data stream allows **one connection per account**: never run a second engine, script or notebook with these keys.

**Kraken (crypto)**: no account and no keys. Market data is public; orders go to the Kraken CLI paper wallet inside the container.

**Vercel AI Gateway**: one `AI_GATEWAY_API_KEY` works for both engines. The gateway needs paid credits.

**useSend** (`USESEND_API_KEY`): sends the owner's sign-in magic links, and the sign-in codes the dashboard asks for when it runs as an installed Home Screen app (that app keeps its own cookies, so a link opened in the browser wouldn't sign it in). Links and codes only ever go to `OWNER_EMAIL`; nobody else can sign in.

**Random secrets**: each bot has its own `STREAM_TOKEN_SECRET` and `BETTER_AUTH_SECRET`; never reuse one across bots. Generate each with:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**News API keys** (optional, free): listed in the ENGINE section of each `.env.<bot>.example`. A source whose key is empty stays off.

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
Copy-Item .env.crypto.example .env.crypto
Copy-Item .env.stock.example .env.stock
Copy-Item .env.history.example .env.history
notepad .env.crypto
notepad .env.stock
notepad .env.history
```

**The wallet volume**: on this server `cryptomarketbot_kraken-paper` already exists and holds the live paper wallet (§6). Only on a brand-new server, create it once with `docker volume create cryptomarketbot_kraken-paper`; the engine creates the workspace on first boot.

---

## 3. The env files

### 3.1 One file per bot

`.env.crypto` and `.env.stock` at the repo root hold everything the bot's engine and dashboard read, under the same variable names as before the merge. Both are git-ignored and kept out of Docker build contexts (`.dockerignore`); only the `.env.<bot>.example` files are committed. Each file has three sections:

| Section | Read by |
| --- | --- |
| SHARED | the engine and the dashboard |
| ENGINE | the engine only |
| DASHBOARD | the dashboard only (Vercel, local dev) |

- **Engine container**: compose loads the whole file (`env_file`). The engine also receives the DASHBOARD values and ignores them (an accepted trade-off).
- **Vercel** can't read the file. The SHARED and DASHBOARD values are set in the Vercel project (§3.4).
- **Local dev**: the `pnpm dev:*` scripts read the file, then `.env.<bot>.local` (§3.5).

### 3.2 What compose sets itself

Don't put these in the env files. `compose.yml` sets them, and its values win over `env_file`:

| Variable | crypto-engine | stock-engine |
| --- | --- | --- |
| `STREAM_HOST` | `0.0.0.0` | `0.0.0.0` |
| `STREAM_PORT` | `8787` | `8788` |
| `SCRAPER_URL` | `http://scraper:8790` | `http://scraper:8790` |
| `LLM_URL` | `http://llm:8080` | `http://llm:8080` |

Crypto also gets `KRAKEN_OHLCVT_DIR=/data/ohlcvt`, the read-only mount of Kraken's history files (§6.5). `HISTORY_URL` is not among them: it carries the bot's history password, so it lives in the bot's env file (§3.6).

### 3.3 Rules

- One value per line, no quotes, no trailing spaces. The engine trims stray `\r`.
- **A value containing `$`** (a Mongo password, say) goes in single quotes: `MONGODB_URI='mongodb+srv://user:pa$word@…'`. Compose expands `$` in unquoted values; single quotes keep it literal for both compose and Node's `--env-file` (local dev). The old `$$` escape doesn't work here: Node reads it as two dollar signs. On Vercel, paste the value without the quotes.
- **All three files must exist** (`.env.crypto`, `.env.stock`, `.env.history`) for any compose command, even one that touches a single engine: compose reads every `env_file` when it loads the project.
- **After editing** a file, run `docker compose up -d <bot>-engine`. That recreates the container with the new values; `restart` keeps the old ones.
- Never commit them or paste their contents anywhere. `docker compose config` without `--quiet` prints every value; don't share its output.

### 3.4 What goes into each Vercel project

Set for Production and Preview, with the same values as the bot's env file. Vercel applies env changes to new deployments only, so redeploy after changing one.

**Crypto** (the cryptomarketbot.app project):

| Variable | Section | Value |
| --- | --- | --- |
| `MONGODB_URI` | SHARED | same as the engine |
| `MONGODB_DB_NAME` | SHARED | `cryptomarketbot` |
| `STREAM_TOKEN_SECRET` | SHARED | **identical** to the engine's |
| `BETTER_AUTH_SECRET` | DASHBOARD | 32+ characters; changing it signs you out everywhere |
| `USESEND_API_KEY` | DASHBOARD | the useSend key |
| `ENGINE_STREAM_URL` | DASHBOARD | `wss://engine.cryptomarketbot.app/v1/stream` |
| `NEXT_PUBLIC_DISPLAY_TIMEZONE` | DASHBOARD | `America/Los_Angeles` |
| `SITE_URL`, `OWNER_EMAIL`, `USESEND_BASE_URL`, `USESEND_FROM_EMAIL` | DASHBOARD | optional; the defaults are in `.env.crypto.example` |

**Stock** (the stockmarketbot.app project):

| Variable | Section | Value |
| --- | --- | --- |
| `MONGODB_URI` | SHARED | same as the engine |
| `MONGODB_DB_NAME` | SHARED | `stockmarketbot` |
| `STREAM_TOKEN_SECRET` | SHARED | **identical** to the engine's |
| `BETTER_AUTH_SECRET` | DASHBOARD | 32+ characters; changing it signs you out everywhere |
| `USESEND_API_KEY` | DASHBOARD | the useSend key |
| `ENGINE_STREAM_URL` | DASHBOARD | `wss://engine.stockmarketbot.app/v1/stream` |
| `DISCORD_WEBHOOK_URL` | DASHBOARD | optional: unhandled dashboard errors go to Discord (the engine reads the same variable for its alerts) |
| `SITE_URL`, `OWNER_EMAIL`, `USESEND_BASE_URL`, `USESEND_FROM_EMAIL` | DASHBOARD | optional; the defaults are in `.env.stock.example` |

Nothing from the ENGINE sections goes to Vercel: the dashboards hold no broker or AI keys. Vercel sets `VERCEL_PROJECT_PRODUCTION_URL` itself (the default for `SITE_URL`); sign in on the production domain, not on preview URLs.

### 3.5 Local dev overrides

`.env.crypto.local` and `.env.stock.local` (git-ignored) are read after the main file, and their values win. Local engines must not touch live state:

```ini
# .env.crypto.local
MONGODB_DB_NAME=cryptomarketbot_dev
DISCORD_WEBHOOK_URL=
HISTORY_URL=
```

```ini
# .env.stock.local
MONGODB_DB_NAME=stockmarketbot_dev
DISCORD_WEBHOOK_URL=
HISTORY_URL=
ALPACA_API_KEY=fake-key
ALPACA_SECRET_KEY=fake-secret
```

- On the live database a local engine would wait for the live engine's lease, and take over trading as soon as the live one stopped.
- A local engine can't reach the `history` service (no host port), and shouldn't write to it anyway: leave `HISTORY_URL=` empty in the `.local` file.
- A local stock engine with the live keys would knock out the live engine's market data (one connection per account). With fake keys it boots and logs Alpaca auth errors.
- A local crypto engine needs the Kraken CLI on `PATH` (or `KRAKEN_CLI_PATH`) and uses that machine's own CLI workspace, never the server's volume.
- A local dashboard on the live database writes real commands that the live engine executes.

### 3.6 The history service's file

`.env.history` (git-ignored; template `.env.history.example`) holds the history service's three passwords. compose loads it into `history` and `history-backup` only; the engines never see it.

| Variable | What |
| --- | --- |
| `POSTGRES_PASSWORD` | the Postgres superuser: creates the databases on the first start, and runs the nightly backup |
| `CRYPTO_HISTORY_PASSWORD` | the `crypto_history` role, which owns the `crypto_history` database and nothing else |
| `STOCK_HISTORY_PASSWORD` | the `stock_history` role, likewise |

Each bot's env file carries its own password in `HISTORY_URL` (ENGINE section), so an engine can reach only its own database:

```ini
# .env.crypto
HISTORY_URL=postgres://crypto_history:<CRYPTO_HISTORY_PASSWORD>@history:5432/crypto_history
```

- The passwords take effect when the `history-data` volume is created (the first start, by `packages/history/docker/initdb.sh`). Changing one in the file afterwards changes nothing: change it in Postgres too (`docker compose exec history psql -U postgres -c "alter role crypto_history password '…'"`), then in the bot's `HISTORY_URL`, then run `docker compose up -d <bot>-engine`.
- Generate them like the other secrets (§1). Hex values need no quoting in a URL.
- Without `HISTORY_URL` an engine keeps no history, and nothing else changes.

---

## 4. Build and start (first time)

```powershell
docker volume inspect cryptomarketbot_kraken-paper   # must exist: the paper wallet (§6)
docker compose config --quiet                       # checks compose.yml and the three env files; silent when fine
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
docker compose up -d --build                   # everything whose image or config changed
```

- Naming the service is how you deploy one bot without touching the other. Shared code (`packages/*`) is compiled into each image at build time, so a change there reaches an engine only when that engine is rebuilt.
- **Stock**: any time, market hours included; pick a moment with no cycle or seed run in progress. Stops rest at Alpaca; options exits wait for the engine, which is back in about a minute.
- **Crypto**: pick a moment with no cycle or seed run in progress. Stops are watched only by the engine; it is back in about a minute.
- A stop is graceful (30 s grace period): the engine releases its lease, so the new container takes over at once.
- **History**: any time. While it's down the engines keep up to 50,000 bars each in memory and copy the news they missed when it's back; trading never waits for it.
- **llm**: any time. Recreating it reloads the model (~1 minute), during which the summaries back off and retry; trading never waits for it.
- Dashboards deploy by pushing to `main` (Vercel, §8).

### 5.2 Status, logs, restart

```powershell
docker compose ps                                          # every service and its health
docker compose logs -f --since 1h crypto-engine            # follow one engine
docker compose logs --since 24h stock-engine | Select-String '"level":"error"'
Get-Content logs\crypto-engine\2026-10-27.log -Tail 50 -Wait   # the history, across deploys (below)
Select-String '"level":"error"' logs\stock-engine\*.log    # every error in the kept history
docker compose restart stock-engine                        # same image, same env
docker compose up -d stock-engine                          # after editing .env.stock
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

The detailed view (every dependency, data freshness, AI spend) is each dashboard's **Admin → System**, fed by the engine's heartbeat. Every news source's health, with its errors when you're signed in, is on the dashboard's **News** page; Admin → System has a one-line summary.

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
| `llm` | 6 GB RAM, 6 CPUs | ~2.5 GB; ~6.8 GB of GPU memory on each card, always (§9) |
| `llm-model` | 256 MB | runs for a moment at each start of `llm` (a few minutes when it downloads) |
| `history` | 2 GB (`shared_buffers` 512 MB, tuned for that) | 0.6–1.2 GB, mostly cache |
| `history-backup` | 256 MB | a few MB; more for a minute at 10:30 UTC |

Check with `docker stats --no-stream` (§5.2).

### 5.6 Settings

Live trading settings (risk, AI budget, models, news engine, schedule) live in MongoDB and change only from the dashboard's **Admin** page, as an audited `settings.update` command. The env files hold only first-boot defaults such as `GROK_RESEARCH_MODEL`; changing those, or `DEFAULT_SETTINGS` in code, doesn't change a running bot.

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
4. Watch it for an hour, then for the rest of the day: memory, errors, triggers, AI spend.

**Afterwards:** remove the old scraper containers (`docker rm stockmarketbot-scraper cryptomarketbot-scraper`, done on 2026-10-26). Keep the old engine containers stopped, not removed, for 14 days (until 2026-11-09). They stay stopped across reboots.

Don't run `docker compose -p <old project> stop|start` from the marketbots folder: compose would load this folder's `compose.yml` under the old project name and can miss the old `engine` service. Use the container names as above, or run compose from the old repo's folder.

### Rollback

```powershell
docker compose stop stock-engine          # in the marketbots folder
docker start stockmarketbot-engine
```

For crypto: `docker compose stop crypto-engine`, then `docker start cryptomarketbot-engine`.

- Both use the same database and the same wallet volume, so nothing needs copying back.
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

---

## 8. Vercel

Both dashboards are on Vercel, in the same two projects as before the merge, with the same domains, env vars and auth. Both build from `colinfran/marketbots`.

### 8.1 Project settings

In each project:

1. *Settings → Build and Deployment*:
   - **Root Directory**: `apps/crypto-web` (stock: `apps/stock-web`).
   - **Include files outside the root directory in the Build Step**: on. The apps import `packages/*`.
   - **Node.js Version**: 22.x.
   - Framework Next.js; install and build commands default (pnpm is detected from the root lockfile).
2. *Settings → Git → Ignored Build Step*: Custom, with the bot's command from §8.2.
3. *Settings → Git*: repo `colinfran/marketbots`, production branch `main`.

After a deploy, check that you can sign in, the stream connects, and a *Pause* / *Resume* round trip works. The old repos no longer deploy anything and can be archived (read-only).

### 8.2 Ignored Build Step

So that a push touching only one bot doesn't rebuild the other bot's dashboard.

Crypto:

```sh
[ -n "$VERCEL_GIT_PREVIOUS_SHA" ] && git diff --quiet "$VERCEL_GIT_PREVIOUS_SHA" HEAD -- :/apps/crypto-web :/packages/core :/packages/crypto-core :/packages/ui :/packages/web-kit :/packages/config :/pnpm-lock.yaml || exit 1
```

Stock:

```sh
[ -n "$VERCEL_GIT_PREVIOUS_SHA" ] && git diff --quiet "$VERCEL_GIT_PREVIOUS_SHA" HEAD -- :/apps/stock-web :/packages/core :/packages/stock-core :/packages/ui :/packages/web-kit :/packages/config :/pnpm-lock.yaml || exit 1
```

- Exit 0 skips the build, exit 1 builds. `git diff --quiet` exits 0 when none of the paths changed since the last deployed commit. Without a previous SHA (the first deploy), or with one git can't find, the command builds.
- The `:/` prefix anchors each path at the repo root. Vercel runs the command from the project's Root Directory, where a plain `apps/crypto-web` would be read as `apps/crypto-web/apps/crypto-web`, match nothing, and skip every build.
- A new shared package that a dashboard imports must be added to both commands.
- A commit that touches only the root `package.json` or `pnpm-workspace.yaml` doesn't trigger a build; redeploy by hand if it matters.

### 8.3 Bad deploys

Vercel's instant rollback (*Deployments* → a previous deployment → *Instant Rollback*), as before.

---

## 9. The local model server (`llm`)

`llm` is llama.cpp's server running **Qwen 3.6 35B-A3B at 2-bit**: Unsloth's `UD-Q2_K_XL`, 12.3 GB. It is split across both GPUs and loaded at all times. [LOCAL-AI.md §5.1](plans/LOCAL-AI.md#51-step-0-results-2026-102728) has the measurements behind the choice.

- **Access:** both engines reach it at `LLM_URL=http://llm:8080`, an OpenAI-compatible API, over the `ai` network. It has no host port and no internet.
- **Work:** it writes the article summaries. Decisions can run on it too: an AI model setting (Admin) of `local/qwen3.6-35b-a3b-q2` sends that call here instead of to the AI Gateway. No setting does yet.
- **When it's down:** the engines keep trading. Only the summaries stop, and the source `enrich:summaries` turns degraded on the dashboard.

**The model file:** `llm-model` is a one-shot container that runs before `llm` starts:
- It downloads the file from Hugging Face, at a pinned commit, into the `marketbots_models` volume.
- It checks the file's SHA-256, and `llm` can't start until the check passes.
- Once checked, the file is kept, and later starts skip the download.

To change the model, edit `llm-model`'s `MODEL_URL`, `MODEL_FILE` and `MODEL_SHA256`, and `llm`'s `--model` and `--alias`, in `compose.yml`. Then run `docker compose up -d llm`. The server's image is pinned by digest.

**How summaries are used:**
- **Which items:** news cluster roots at severity ≥ `wire.summaries.min_severity` (Admin), and never on the trigger path.
- **Which model:** whichever the server serves. Its alias (`qwen3.6-35b-a3b-q2`) is recorded on each summary. Summaries don't think: each request turns thinking off.
- **Where they show:** under the item on the News page.
- **In prompts:** the AI's wire dossier carries the summaries of its 8 best-ranked items. Each is labelled as a machine summary, and the AI is told to cite the item's URL, never the summary.
- **Turning them off:** set `wire.summaries.enabled` to off in Admin.

**Requirements:** both NVIDIA GPUs, the Windows NVIDIA driver, and Docker Desktop's WSL2 backend, which passes the GPUs to containers (Jellyfin already uses the 3070 that way).

```powershell
docker compose up -d llm                                    # llm-model first (exits at once if the file is there), then llm
docker compose logs llm-model                               # "have …", or the download and its check
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
- **Container:** `mem_limit: 6g` (it holds ~2.5 GB), `cpus: 6`. llama.cpp's 6 threads spin while they wait, so a 4-CPU cap throttled them: 36–40 tokens/s against 45–46 at 6. Idle, it uses next to no CPU.
- **GPU:** ~6.8 GB on each card.
- **Power:** the 2080 SUPER is capped at 180 W (§2).

**Local decisions** (`local/<alias>` model settings, `AiRunner` in `@mb/engine-kit`):
- **Cost:** none. Their calls are in `ai_calls` with `cost_usd: 0` and `cost_source: "local"`, with their tokens and time.
- **Thinking:** the model's default, and Qwen 3.6 thinks. A crypto decision took ~3 minutes in step 0 (up to 4¼), against default timeouts of 240 s for decisions and 90 s for event decisions. Raise them in Admin (300 s at most) before pointing a decision model here.
- **Research:** no. It needs Grok's live web and X search, so `models.research` stays a gateway model.
- **Without LLM_URL:** a `local/…` model is refused, and never becomes a fallback.

**The speed guard:** llama.cpp doesn't report where its tensors sit, so the engines judge by speed. A summary written slower than 20 tokens/s pauses summaries for 30 minutes. Normal is 40–50 tokens/s, less per request while other slots run. A model spilled into system RAM writes 15–20.

**Leftovers:** Ollama's `marketbots_ollama-models` volume (~2 GB, `llama3.2:3b`) is no longer used. `marketbots_models` also holds the step-0 candidates beside the model in use. Delete either only on purpose: `docker volume rm` can't be undone.

---

## 10. Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| `env file ...\.env.stock not found` from any compose command | Both `.env.crypto` and `.env.stock` must exist at the repo root, even to start one engine. |
| `external volume "cryptomarketbot_kraken-paper" not found` | The wallet volume is missing. Don't create an empty one on this server: check `docker volume ls`, then restore a backup (§6.2). |
| `port is already allocated` on `docker compose up` | Another container holds 8787/8788, usually an old engine (`docker ps`). Stop it. Don't move the port: Caddy targets it. |
| `Invalid engine environment` in logs | A required variable is missing or too short (secrets need 32+ characters). Fix the env file, then `docker compose up -d <bot>-engine`. |
| `MongoDB connection failed; retrying` | Atlas *Network Access* doesn't include the server's IP, or the URI/password is wrong (a `$` in it: §3.3). |
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
| AI calls fail with "BYOK is available only with paid credits" | Add credits to the Vercel AI Gateway. |
| "Owner sign-in is not configured" | `BETTER_AUTH_SECRET` (32+ characters) or `MONGODB_URI` is missing on Vercel. |
| No sign-in email arrives | `USESEND_API_KEY` is missing or wrong, or the sender domain isn't verified in useSend (Vercel function logs show the error). Only `OWNER_EMAIL` is ever emailed. |
| Vercel skips every build | The Ignored Build Step paths aren't anchored with `:/` (§8.2). |
| Vercel build can't resolve `@mb/...` | *Include files outside the root directory* is off (§8.1). |
| `llm` won't start: `could not select device driver "nvidia"` | Docker can't see the GPUs: update the NVIDIA driver and Docker Desktop, and check the WSL2 backend is on. |
| `llm` exits at start with `cudaMalloc failed: out of memory` | Something else holds GPU memory (a game, a second model server, a big transcode). Free it, then `docker compose up -d llm`. |
| `llm` never starts: `llm-model` exited with `SHA-256 mismatch` | The download is corrupt or the pinned file changed. It was removed; `docker compose up -d llm` downloads it again. |
| *enrich:summaries* degraded: `… wrote 12.3 tokens/s (floor 20): paused for 30 min` | The model ran slowly: spilled into system RAM, or the GPUs are busy with something else. Summaries resume by themselves after 30 minutes; check `nvidia-smi`. |
| *enrich:summaries* degraded: `GET /v1/models failed (503)` | The server is still loading the model (~1 minute after a start). |
| `env file ...\.env.history not found` | Create it from `.env.history.example` (§3.6). |
| Admin → System: *History store: unreachable*, log `history store unavailable; retrying in a minute` | `docker compose ps history`: not running, or still starting. A `password authentication failed` means the bot's `HISTORY_URL` doesn't match the role's password (§3.6). The engine keeps trading and retries every minute. |
| *History store* shows bars *dropped* | It was down long enough for an engine's 50,000-bar buffer to fill. The backfills can fetch those minutes again. |
| `history-backup` logs `backup of … failed (no news archive yet?)` | Normal until the engine has migrated its database; otherwise check `docker compose logs history`. |
