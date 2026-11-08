# Plan: everything on the server (the web apps and MongoDB)

Status: **built and moved on 2026-11-07**, all at once (no phases). The plan below is the 11-05 proposal as the owner approved it; where the build differs, *As built* says so, and [SERVER.md](../SERVER.md) describes the running setup.

The proposal (revised 2026-11-05): The first version (11-03) moved only the database and kept the dashboards on Vercel, which reached it through an mTLS gate on a public port. The owner has since asked to host the dashboards and the landing page here too, and will change the DNS in Vercel. This version replaces the first. Researched from this repo, the server (Docker, Caddy, probes from throwaway containers on 11-05) and the vendors' docs (Sources). §13 lists what needs the owner's OK before any code is written.

## As built (2026-11-07)

The owner's decisions (§13):

1. **The landing page stays on Vercel**, at marketbots.vercel.app. Only the two dashboards moved: `crypto-web` on 127.0.0.1:3101 and `stock-web` on 3102, behind Caddy at cryptomarketbot.app and stockmarketbot.app. No `landing` container, no port 3103, no landing domain.
2. **No phases or dates**: everything on 11-07, one session (the code in one commit, then the database cutover and the DNS switch).
3. **Backups daily, like the wallet**: `mongo-backup` dumps the whole server (`mongodump --oplog`) into `backups\mongo\` once at start, then daily at 11:00 UTC, the newest 14 kept (not every 6 hours with 28).
4. **Automatic deploys**, but without polling: every commit on `main` in the server's working tree (and a `git pull` that moves it) deploys the dashboards. The repo's `.githooks/post-commit` and `post-merge` start the on-demand task `\marketbots\Web deploy`, which runs `docker/web/autodeploy.mjs`: it fetches `main` from the local repo into a clean clone, `..\marketbots-deploy` (never the working tree), and runs `docker compose up -d --build` for each dashboard there. Docker's cache keeps a dashboard whose image didn't change. Failures go to the bot's Discord channel. The engines still deploy by name. ([SERVER.md §8](../SERVER.md#8-the-web-apps).)
5. **Clean-up**: the owner deletes the two dashboards' Vercel projects and the Azure cluster once everything is verified, with no fixed windows.

Other differences from the plan:

- **Caddy's admin API moved to 127.0.0.2:2019** (global option `admin 127.0.0.2:2019`) instead of a Unix socket or `admin off`. Containers reach the host's 127.0.0.1 through `host.docker.internal` but not 127.0.0.2 (probed on 11-07 with listeners on both), so reloads still work without restarting Caddy: `caddy reload --address 127.0.0.2:2019`, or a POST of the Caddyfile to `/load` where Application Control blocks `caddy.exe` (agent sessions).
- The web image takes a second build argument, `CORE` (the bot's core package), and copies only the app and the packages it uses, so a commit that doesn't touch a dashboard leaves its image and container as they are.
- `mongo` runs as the image's `mongodb` user with a read-only root and no capabilities. The dashboard roles are `crypto_dashboard` and `stock_dashboard` (admin database): `dbStats` on every database, for the storage card.
- `.env`'s `MONGODB_URI` stays the Azure one (local dev) until the cluster is deleted; `.env.example` already has mongo-dev's.
- Still to come, separately and owner-approved (§7.12): the landing page's topology text, and Admin → System's storage card (its Azure wording and the 32 GB limit).

## 1. Why

### The database

Both bots' MongoDB is one Azure DocumentDB free-tier cluster (West US, MongoDB 8.0 API). Since 2026-10-31 09:15 UTC its CPU has been capped:

| When | CPU (Azure Monitor, hourly average) |
| --- | --- |
| Until 10-31 09:15 UTC | 25–27%, flat |
| 11-02 | 90–98% all day |
| 11-03, after the 11-02 load cuts were deployed | 81–92% overnight, then 96–99% from ~13:00 UTC. Every hour touches 100% |

A capped cluster refuses some queries with `An unexpected internal error has occurred.` (code 261). The engines retry them (about 24 warnings on 11-03; on 11-05 a crypto deploy needed 9 connect attempts, ~2.3 minutes, to boot). The dashboards don't retry: a refused query fails the page, and `instrumentation.ts` posts *Server error on …* to Discord. That is the alert stream.

The free tier's compute is burstable and Microsoft doesn't publish its allowance. The CPU percentage is measured against that allowance, so it reads ~100% whenever the load is above it, by any margin. With roughly half the queries of 10-30 the cluster is still pinned, so the allowance is below what is left, by an unknown margin. More cuts would be a guessing game, and the free tier has no backups either. A local `mongod` has no cap, costs nothing and can be backed up like the wallet. The data is small: 193 MB of databases on 10-30.

### The web apps

The web apps are the two dashboards and the landing page.

- **The database never faces the internet.** With the dashboards on Vercel, the first version needed a public port, an HAProxy gate, our own CA, client certificates on Vercel and TLS code in web-kit. With the dashboards here, `mongod` sits on an internal Docker network, and all of that goes.
- **One place.** One `.env` feeds every container; no secrets are copied into three Vercel projects. One Node process per dashboard, so the Discord alert de-dupe (in memory, today per Vercel instance) works as meant.
- **Deploys like the engines:** `docker compose up -d --build crypto-web`, from the commit on the server, with no wait for a push.
- **Given up:**
  - Vercel's CDN, preview deployments and deploy on push.
  - Its firewall, and the mitigations it applies at its edge for Next.js advisories. Self-hosted, we patch ourselves (§12).
  - Uptime apart from the server. That one costs little: without the server the dashboards already lose the stream, the engine status and every command.

## 2. Summary

- **Web apps:** `crypto-web`, `stock-web` and `landing` become containers in the `marketbots` stack: each app's Next.js standalone server, on loopback ports 3101, 3102 and 3103. Caddy on the host terminates TLS for `cryptomarketbot.app`, `stockmarketbot.app` (their `www.` names redirect, as they do today) and the landing page's domain (decision 1), as it already does for `engine.*`.
- **What they reach:** the engines and the host agent through `host.docker.internal`, which Docker Desktop forwards to the host's loopback (checked on 11-05: both engines' `/healthz` 200, the agent 401 without its secret), so no engine changes network for them. MongoDB over a new internal network, `db`.
- **The database:** `mongo`, MongoDB 8.0.34 (the official image pinned by digest), runs as a single-member replica set because Better Auth's sign-in writes use transactions, which a standalone server refuses. Auth is on, with one user per bot and role. The data lives in the named volume `marketbots_mongo-data`, `external` like the wallet. No host port, no internet.
- **Backups:** `mongo-backup` runs `mongodump` every 6 hours into `backups\mongo\` on C: and keeps the newest 28 (decision 3). Today there are none.
- **DNS:** the owner points the apex and `www` records at the server's address in Vercel DNS, the address the `engine.*` records already use. No router change: ports 80 and 443 already reach Caddy.
- **Code:** a standalone build in each `next.config.ts`, one Dockerfile for the three web apps, an optional `ENGINE_URL` in web-kit, `.dockerignore`, compose, the smoke file. No contract snapshot changes.
- **Rollout:**
  1. Build everything beside today's setup; nothing switches.
  2. Move the web apps, still reading Azure. Vercel stays as the rollback.
  3. Rehearse the database move with a copy.
  4. A ~15-minute database cutover with the engines and dashboards stopped.
  5. Delete the Vercel projects after 7 days and Azure after 14.

## 3. The topology afterwards

```
Browser ──https──▶ Caddy on the Windows host
                     ├─ cryptomarketbot.app  ──▶ 127.0.0.1:3101  crypto-web ─┐
                     ├─ stockmarketbot.app   ──▶ 127.0.0.1:3102  stock-web  ─┤
                     ├─ <landing domain>     ──▶ 127.0.0.1:3103  landing     │  (no database, no secrets)
                     └─ engine.<domain>      ──▶ 127.0.0.1:8787 / 8788 engines: the stream and health only (phase 4)
crypto-web, stock-web ──▶ host.docker.internal:8787 / 8788   the engines' signed /v1/status and /v1/commands
                      ──▶ host.docker.internal:8789          the host agent (Admin → Server)
                      ──▶ mongo:27017 on network db ◀── crypto-engine, stock-engine, mongo-backup
```

| Network | Members | Internet |
| --- | --- | --- |
| `default` | the engines, `scraper`, `search`, `wallet-backup` | yes |
| `ai` (internal) | the engines, `llm`, `history`, `history-backup` | no |
| `db` (new, internal) | `mongo`, `mongo-backup`; the engines and dashboards from the cutover | no |
| `web` (new) | `crypto-web`, `stock-web`, `landing` | yes: useSend, Discord, Kraken's candles for the crypto charts, and Azure until the cutover |

The web apps get a network of their own rather than `default`, so an internet-facing server can't reach the scraper (a headless browser with no auth) or `search` (whose paid engine goes through the per-GB proxy).

## 4. The new services

```yaml
  crypto-web:                  # the crypto dashboard: its Next.js standalone server
    <<: *hardened              # read-only root, no capabilities, no-new-privileges; runs as `node`
    build:
      context: .
      dockerfile: docker/web/Dockerfile
      args: { APP: crypto-web, NEXT_PUBLIC_DISPLAY_TIMEZONE: "${NEXT_PUBLIC_DISPLAY_TIMEZONE:-}" }
    image: marketbots-crypto-web:latest
    container_name: marketbots-crypto-web
    init: true
    environment: { … }         # §6.3
    ports: ["127.0.0.1:3101:3000"]   # Caddy forwards https://cryptomarketbot.app here
    networks: [web]            # and db, from the cutover commit
    tmpfs: [/tmp, /app/apps/crypto-web/.next/cache]   # Next's fetch cache (the candles route)
    stop_grace_period: 10s
    mem_limit: 512m
  stock-web:                   # the same, port 3102
  landing:                     # the same, port 3103, mem_limit 256m: no database and no secrets

  mongo:                       # MongoDB 8.0.34, single-member replica set "rs0"
    image: mongo:8.0.34@sha256:…
    container_name: marketbots-mongo
    restart: unless-stopped
    # docker/mongo/start.sh writes a fresh keyFile to tmpfs (a replica set with auth needs one;
    # with a single member nothing else reads it), then runs the image's own entrypoint.
    entrypoint: ["sh", "/etc/mongo/start.sh"]
    command: [mongod, --replSet, rs0, --keyFile, /run/mongo/keyfile, --bind_ip_all,
              --wiredTigerCacheSizeGB, "0.5", --networkMessageCompressors, disabled]
    volumes:
      - mongo-data:/data/db
      - ./docker/mongo/start.sh:/etc/mongo/start.sh:ro
    tmpfs: [/run/mongo]
    networks: [db]             # no host port, no internet
    healthcheck: mongosh --quiet --eval "db.adminCommand('ping').ok"
    stop_grace_period: 60s
    mem_limit: 1536m

  mongo-backup:                # mongodump --oplog every 6 h into backups/mongo/, the newest 28 kept
    image: mongo:8.0.34@sha256:…
    …                          # the history-backup pattern; networks: [db]

  mongo-dev:                   # local dev only (profile "dev"), never the live data
    profiles: ["dev"]
    image: mongo:8.0.34@sha256:…
    ports: ["127.0.0.1:27018:27017"]
    …                          # a one-member replica set, no auth (loopback only), its own volume

volumes:
  mongo-data:                  # THE books: external, so compose never creates an empty one
    external: true
    name: marketbots_mongo-data
```

- **The web image** (`docker/web/Dockerfile`, one for the three apps, `APP` as a build argument):
  - The build stage follows the engines' Dockerfiles: `pnpm fetch`, an offline install filtered to `@mb/<app>...`, then `next build`.
  - The runtime is the engines' pinned `node:22-bookworm-slim` (Vercel ran Node 24; Next 16 supports both), with tini, non-root. It holds the standalone server with `.next/static` and `public`.
  - Healthcheck: `/robots.txt`, which needs no database.
  - Every page awaits `connection()`, so nothing reads the database at build time.
  - `NEXT_PUBLIC_DISPLAY_TIMEZONE` is a build argument because Next writes `NEXT_PUBLIC_` values into the browser code at build time. Its value is the code's default anyway.
- **Gzip:** Next's server compresses its own responses, so Caddy adds no `encode`, which could hold back streamed pages.
- **Database data on a named volume** (ext4 inside Docker's disk on C:), never a bind mount from NTFS: MongoDB needs real fsync and file locking.
- **Memory:**
  - The Docker VM has 15.5 GiB, and the running containers used ~7 GiB on 11-05 (`llm` 4.3, `history` 1.1).
  - The new caps add ~2.8 GB; expected use is ~1 GB: each dashboard ~150–250 MB, `mongo` ~0.3 GB of WiredTiger cache for ~0.2 GB of data.
  - A `next build` inside Docker briefly takes 1–2 GB more.
- **First start, once:** `docker/mongo/init.js` (idempotent), run through `docker compose exec mongo mongosh` and the localhost exception. It runs `rs.initiate` with the member `mongo:27017`, then creates the root user, the `dashboard` role and the users in §6.
- **No `depends_on`.** An engine that starts before `mongo` retries until it connects (`connectMongo`), as it does today. A dashboard answers with an error page until then. Deploying one engine or dashboard never starts or recreates `mongo`.

## 5. Caddy, DNS and the host's loopback

**Caddy sites** (in `C:\Caddy\Caddyfile`, added only once the DNS answers with the server's address, phase 1):

```caddy
(webapp) {
	# The web apps use no WebSockets (the stream goes to engine.<domain>) and no image optimizer:
	# both are where 2026's self-hosted-only Next.js advisories were (§12).
	@upgrade header Upgrade *
	respond @upgrade 400
	respond /_next/image* 404
}

cryptomarketbot.app {
	import webapp
	reverse_proxy 127.0.0.1:3101
}
www.cryptomarketbot.app {
	redir https://cryptomarketbot.app{uri} permanent
}
# stockmarketbot.app → 3102 and the landing domain → 3103, the same way.
```

- Caddy sets `X-Forwarded-For` to the visitor's address and ignores one sent by the visitor, so the login rate limit, which keys on a hash of the address, keeps working as it did behind Vercel. `sameOrigin` reads `X-Forwarded-Host`, which Caddy sets too.
- **Phase 4: the engine sites serve only `/v1/stream`, `/healthz` and `/readyz`.**
  - `/host/*` goes, and `/v1/status` and `/v1/commands` stop answering from the internet.
  - Only the dashboards call those, and from phase 1 they call over `host.docker.internal`.

**DNS: the target, for the owner in Vercel.** Today both apexes are served by Vercel and their `www` names redirect to them (307, checked 11-05).

| Name | Record |
| --- | --- |
| `cryptomarketbot.app`, `www.cryptomarketbot.app` | A, the address `engine.cryptomarketbot.app` already uses |
| `stockmarketbot.app`, `www.stockmarketbot.app` | A, the same address |
| the landing domain (decision 1) | A, the same address |

- In each Vercel project, *Settings → Domains*: remove the apex and `www`. Then, in the domain's DNS records, delete any record for `@` or `www` that still points at Vercel (A `76.76.21.21`, an ALIAS, or a CNAME to `cname.vercel-dns.com`), and add the A records.
- Leave every other record alone: the `engine.*` A records, and the TXT and MX records useSend's sender verification may use. A CAA record, if there is one, must allow `letsencrypt.org`.
- Keep the domains and the Vercel account: Vercel keeps hosting their DNS after the projects are deleted.
- Both domains are `.app`, which browsers only load over HTTPS. A visitor whose resolver switches before Caddy has its certificate sees a TLS error for a minute or two. That is why the Caddy sites go in right after the switch, not before: Caddy can't get a certificate while the name points at Vercel, and its failed tries would back off.

**The host's loopback is open to every container, Caddy's admin API included.**

- Docker Desktop forwards `host.docker.internal` to the Windows host's 127.0.0.1. The plan uses that to reach the engines and the agent.
- It also reaches Caddy's admin API on 127.0.0.1:2019. On 11-05 a throwaway container read Caddy's configuration through it with a forged `Host` header (200). Code running in any container on this machine can therefore rewrite Caddy, for example to serve `C:\` on a public site.
- That is true today: the scraper's Chromium renders untrusted pages, and other stacks share this Docker. An internet-facing Next.js server makes it urgent.
- **Fixed in phase 0, before any web app is published:** the admin API moves to a Unix socket if this `caddy.exe` accepts one on Windows (tried first). Otherwise `admin off`, after which a Caddyfile change means restarting Caddy's task (every site blinks for a second) instead of `caddy reload`.
- The other loopback services all require a secret: the host agent, LibreHardwareMonitor, the engines' signed API, and the cron stack's Postgres.

## 6. Users and variables

### 6.1 Database users

| User (in `admin`) | Roles | Used by |
| --- | --- | --- |
| `root` | `root` | `init.js`, and maintenance by hand (`docker compose exec mongo mongosh`) |
| `crypto_engine`, `stock_engine` | `readWrite` on its own database | each engine |
| `crypto_web`, `stock_web` | `dashboard` on its own database: `find`, plus writes to `audit_log`, `login_attempts` and the four `auth_*` collections (from a grep of every dashboard write); `dbStats`, and `listDatabases` for Admin → System's storage card | each dashboard |
| `backup` | `backup` | `mongo-backup` |

A dashboard that is broken into can't change the books or touch the other bot. The engines are kept out of each other's databases too, which DocumentDB couldn't do (SERVER.md §1: "every user sees the whole cluster").

### 6.2 `.env`

| Name | Section | What |
| --- | --- | --- |
| `MONGO_ROOT_PASSWORD`, `MONGO_CRYPTO_ENGINE_PASSWORD`, `MONGO_STOCK_ENGINE_PASSWORD`, `MONGO_CRYPTO_WEB_PASSWORD`, `MONGO_STOCK_WEB_PASSWORD`, `MONGO_BACKUP_PASSWORD` | a new MONGO section, hex like HISTORY's | read by `init.js`. compose builds every `MONGODB_URI` from them, the way it builds `HISTORY_URL`: `mongodb://crypto_engine:${MONGO_CRYPTO_ENGINE_PASSWORD}@mongo:27017/?authSource=admin&replicaSet=rs0` |
| `MONGODB_URI` | SHARED | Azure until the rollback window ends (the engines, and the dashboards until the cutover). Then local dev's: `mongodb://127.0.0.1:27018/?directConnection=true` (`mongo-dev`) |
| `AZURE_*` | SHARED | not passed to the containers: Admin → System's storage card falls back to MongoDB's own numbers. Deleted with the cluster |

No TLS or certificate variables: the gate is gone.

### 6.3 What each dashboard container gets

The values Vercel holds today, from `.env`, the way compose already feeds the engines (crypto shown; stock uses `STOCK_*`, port 8788 and its own domain):

| Variable | From | Notes |
| --- | --- | --- |
| `MONGODB_URI` | `MONGODB_URI` (Azure) until the cutover commit; then built from `MONGO_CRYPTO_WEB_PASSWORD` | §6.2 |
| `MONGODB_DB_NAME` | `CRYPTO_MONGODB_DB_NAME` | |
| `SITE_URL` | compose: `https://cryptomarketbot.app` | sign-in links point here (Vercel set it through `VERCEL_PROJECT_PRODUCTION_URL`) |
| `ENGINE_STREAM_URL` | `CRYPTO_ENGINE_STREAM_URL` | the browser's stream, unchanged |
| `ENGINE_URL` (new) | compose: `http://host.docker.internal:8787` | the dashboard's server calls the engine here (§7.1) |
| `STREAM_TOKEN_SECRET` | `CRYPTO_STREAM_TOKEN_SECRET` | the engine's own value, so they can't drift |
| `BETTER_AUTH_SECRET` | `CRYPTO_BETTER_AUTH_SECRET` | the owner stays signed in if it matches Vercel's (it did on 10-30); otherwise one new sign-in |
| `OWNER_EMAIL`, `USESEND_API_KEY`, `USESEND_BASE_URL` | the same names | |
| `USESEND_FROM_EMAIL` | `CRYPTO_USESEND_FROM_EMAIL` | |
| `DISCORD_WEBHOOK_URL` | `CRYPTO_DISCORD_WEBHOOK_URL` | |
| `NEXT_PUBLIC_DISPLAY_TIMEZONE` | the same name | also a build argument (§4) |
| `HOST_API_URL` | compose: `http://host.docker.internal:8789` | |
| `HOST_API_SECRET` | `HOST_API_SECRET` | |

`landing` gets none of these.

## 7. Changes in this repo

1. **`packages/web-kit`:**
   - `env.ts` reads an optional `ENGINE_URL`. `engine-link.ts` sends the signed calls there; without it, to the stream URL's origin as today. So local dev and the code can ship before any move.
   - Comments that say Vercel, Azure or "serverless instance" are updated.
   - New tests cover both cases.
2. **Each `next.config.ts`** (three apps): `output: "standalone"`, and `outputFileTracingRoot` at the repo root so the trace includes the workspace packages. Vercel still builds the apps until phase 1. If it ever refused this setting, a failed Vercel build leaves the live deployment in place.
3. **`docker/web/Dockerfile`** (new, §4).
4. **`.dockerignore`:** it keeps the dashboards' sources out today; it lets them in. Env files, `.next` and `node_modules` stay out. The engine images don't change: their Dockerfiles copy only their own paths.
5. **`compose.yml`**, in two commits:
   - **Phase 0:** the three web apps (on Azure), `mongo`, `mongo-backup`, `mongo-dev`, the `db` and `web` networks, and the volume. The engines are untouched.
   - **At the cutover, never before:** the engines and dashboards join `db`, and their `MONGODB_URI` is built for `mongo`. An engine started on the empty local database would see a fresh database, and the crypto engine resets the paper wallet to match.
6. **`docker/mongo/`** (new): `start.sh` and `init.js`.
7. **`compose.smoke.yml`:**
   - Its `mongo` is pinned to `mongo:8.0.34` and runs as a one-member replica set, so sign-in works there.
   - The dashboard images boot on loopback 13101 and 13102 against the smoke engines and their test secret. This replaces Vercel's preview deployments.
8. **`.env.example`:** the MONGO section. The dashboards' comments say "the web containers" instead of Vercel. The Azure lines go in phase 4.
9. **`apps/landing/lib/site.ts`:** the landing page's new URL (decision 1).
10. **The crypto candles route:** only its comment changes. It said Vercel's IPs keep chart traffic off the engine's Kraken limit, which stops being true (§12).
11. **Docs:**
    - SERVER.md:
      - what runs where, §1 the database, §2 Caddy's sites and admin endpoint;
      - §3, the dashboards' variables: this §6.3 replaces the Vercel table;
      - §5, deploying the web apps, the checks after a deploy and the memory caps;
      - a new §6 section for the database volume and its backups;
      - §7, a record of the move; §8, *Vercel* becomes *The web apps*; §10, troubleshooting.
    - ARCHITECTURE.md: the topology, the runtime and build tables, configuration.
    - AGENTS.md:
      - Rule 4 points to compose instead of the Vercel table.
      - Rule 6 adds `marketbots_mongo-data` to the volumes nobody touches.
      - Rule 7 covers the web apps (`crypto-web` never redeploys `stock-web`), and notes that recreating `mongo` pauses both bots' database for a few seconds.
      - *Gate, commit, deploy*: a push deploys nothing any more, and the web apps deploy by name like the engines.
    - compose.yml's header. CRYPTO.md and STOCK.md where they name DocumentDB or Vercel. The `apps/*/AGENTS.md` files stay as they are (`next dev` writes them).
12. **After the move, separately** (visible text, owner-approved):
    - The landing page's topology stops saying "Vercel dashboards" and "Azure DocumentDB".
    - Admin → System's storage card drops its Azure part, and `DB_STORAGE_LIMIT_BYTES` (32 GB, the free tier's disk) is reworked for a local disk.

The test count goes up. Contract snapshots don't change: no settings, schemas, indexes or events change.

## 8. How the ground rules hold

- **Paper only:** untouched.
- **Never two engines on one broker state:** the rehearsal boots the engine images against `_rehearsal` copies of the databases, under compose.smoke.yml's safeguards: a copy of the wallet volume and fake Alpaca keys. The live engines switch only at the cutover, and both are stopped first. The web apps hold no broker keys.
- **Settings:** the restore carries the live settings over unchanged. No script writes settings.
- **Env files:** passwords and URIs live only in `.env`, and from phase 4 no longer on Vercel too. Checks use regex booleans and never echo a value. No secret is a build argument.
- **Volumes:** the new volume is `external` and joins rule 6. `down -v`, `volume rm` and `prune` stay forbidden.
- **One bot's change never redeploys the other:** each web app deploys by name. `mongo` is shared, like `history`: recreating it is a deploy of both bots' database, done only at quiet times. The cutover touches both bots by design, once.

## 9. Rollout

### Phase 0: build (nothing switches)

| Step | Who |
| --- | --- |
| Code, compose, `docker/`, the docs. The gate (typecheck, test, lint, build), then one commit | implementer |
| Caddy's admin API off TCP (§5), then Caddy restarted or reloaded. Every site blinks for a second | implementer, with the owner's OK |
| Build the three web images. Passwords into `.env`, `docker volume create marketbots_mongo-data`, `docker compose up -d mongo mongo-backup`, then `init.js` | implementer |
| `docker compose up -d crypto-web stock-web landing` (on Azure), then checks from the server: pages render on 127.0.0.1:3101–3103; `mongo` refuses a query without a password; a dashboard user can't write an engine collection such as `events` | implementer |
| Push. Vercel builds once more with the standalone setting; nothing changes there | owner |

### Phase 1: the web apps move (proposed Friday 11-06; the engines aren't touched)

1. Owner, in Vercel: the DNS changes in §5, for both dashboards and, if decision 1 moves it, the landing page.
2. Implementer: once public resolvers (1.1.1.1, 8.8.8.8) answer with the server's address, add the Caddy sites, validate and reload. Caddy gets the certificates within seconds.
3. Checks:
   - Pages render on both domains, and the stream connects.
   - A magic-link sign-in works, and its link points at the right domain.
   - *Pause* → *Resume* works.
   - Admin → System is green, and Admin → Server shows the machine.
   - The audit entry for the sign-in has a client hash (the visitor's address reached the app).
   - No *Server error* alerts beyond Azure's usual ones.
4. Owner, in Vercel: in each project, *Settings → Git → Disconnect*, so pushes stop building there. The projects and their last deployments stay, as the rollback.

Visitors whose resolvers still answer with Vercel's address keep seeing Vercel for a few minutes. Both copies read the same Azure data and send commands to the same engines.

### Phase 2: database rehearsal with a copy (no live impact beyond a read load on Azure)

1. `mongodump` from Azure, off-hours, one collection at a time and with timeouts. The dump adds load on the capped cluster, so expect a few more 261 warnings while it runs. It also measures how long the cutover's copy will take.
2. Restore into `mongo` as `cryptomarketbot_rehearsal` and `stockmarketbot_rehearsal`, with `--noIndexRestore`: DocumentDB's index metadata may not restore into MongoDB, and the engines build their `INDEXES` at start anyway. Then compare every collection's documents, as on 10-30.
3. With a throwaway override file (deleted afterwards), boot both engine images and both dashboard images against the rehearsal databases. The engines get a wallet copy, fake Alpaca keys and no Discord, on loopback ports. This proves that the indexes build on the real data, the books load with auth and the replica set, and the pages render from `mongo`. Page timings are compared with Azure's.

### Phase 3: database cutover (~15 minutes; proposed Saturday 11-07, decision 2)

1. Check that no agent episode is running in either bot, then `docker compose stop crypto-engine stock-engine crypto-web stock-web`. The dashboards answer 502 until step 4. A one-line maintenance page through Caddy's `handle_errors` is optional.
2. `mongodump` both databases from Azure into `backups\mongo-azure-2026-11-07\`. This is also the rollback copy.
3. Drop the rehearsal databases, restore into `cryptomarketbot` and `stockmarketbot`, and compare every collection's documents. **Stop here if anything differs.** `docker compose start` on the four services brings everything back on Azure.
4. Make the cutover commit (§7.5) and run `docker compose up -d crypto-engine stock-engine crypto-web stock-web`. The images don't change, only their `MONGODB_URI` and networks. Then run the checks in SERVER.md §5.4, and make sure the crypto log has no `paper workspace reset` line.
5. Checks:
   - Pages render, and a magic-link sign-in works (it uses a transaction).
   - *Pause* → *Resume* works.
   - Admin → System is green, and `docker stats` looks normal.
   - No *Server error* alerts arrive.

### Phase 4: after

- **The first 24 hours:** watch Discord and `docker stats`, and check that the first backups land in `backups\mongo\`.
- **After a quiet day:** the engine sites in the Caddyfile serve only the stream and health (§5).
- **From 11-13, with the owner's OK:**
  - Delete the three Vercel projects, and with them Vercel's copies of the secrets.
  - Keep the domains (Vercel hosts their DNS).
  - The Vercel GitHub app can be removed from the repo.
  - The Atlas cleanup keeps its own date (11-13, SERVER.md §7).
- **From 11-21, with the owner's OK:** delete the Azure cluster, its metrics service principal, the `AZURE_*` values and the Azure `MONGODB_URI` (SHARED becomes local dev's, §6.2).
- **Optional, later, owner-approved:** loosen the dashboards' 4-connection cap and the 15-second caches, which were added for the free tier. They're harmless as they are.

## 10. Rollback

- **Phase 1** (until the Vercel projects are deleted):
  1. Add the domains back to their Vercel projects and remove the A records.
  2. Reconnect Git, and remove the Caddy sites.
  3. Vercel's last deployment still reads Azure, so this takes minutes.
- **Phase 3** (until Azure is deleted):
  1. Stop the engines and dashboards.
  2. If anything was written since the cutover, dump the local databases and restore them into Azure, one collection at a time.
  3. Revert the cutover commit and recreate the four services.

  That goes back to the capped cluster, so it's for a broken move, not a slow one.

## 11. Deploying the web apps afterwards

- `docker compose up -d --build crypto-web` (or `stock-web`, `landing`) after the gate and the commit, from the server's working tree, like the engines. A change in `@mb/ui` or `@mb/web-kit` means both dashboards, and the landing page if it uses what changed.
- The old container keeps serving during the build. The swap costs a few seconds of 502 from Caddy, at any time of day: a dashboard deploy never touches trading.
- **Logs:** `docker compose logs crypto-web` instead of `vercel logs`. Unhandled errors still go to Discord.
- **Bad deploy:** redeploy the previous commit. For an instant switch back, tag the running image before a risky deploy (`docker tag marketbots-crypto-web:latest marketbots-crypto-web:prev`).
- **Previews:** compose.smoke.yml (§7.7), or `pnpm dev:<bot>-web` against `mongo-dev`.

## 12. Risks

| Risk | Mitigation |
| --- | --- |
| Next.js advisories that hit only self-hosted servers. In 2025–2026 Vercel shielded its own apps at the edge. Reported examples: a WebSocket-upgrade SSRF in Next's built-in server (May 2026), and an RCE in the image optimizer (August 2026). The React Server Components RCE (CVE-2025-55182, December 2025, CVSS 10, exploited in the wild) hit every host | The repo is on Next 16.4.3, past every fix listed in the sources. Caddy refuses upgrades and `/_next/image` (§5). The containers are hardened and can't reach `llm`, `history`, `search`, the scraper, the Docker socket or the host's files. Dependabot security alerts on the GitHub repo (owner, free), and a Next security release is deployed within days, by name |
| A web app broken into | It holds what Vercel holds today: the stream secret (it can send the bot's commands, which are paper only), the host agent's secret (the fans; the agent forces 100% at 85 °C, and the BIOS keeps its own protection), and a database user that can't touch the books. Caddy's admin API is off TCP (§5) |
| The server or the home internet goes down: the sites are down too | The engines go down with it anyway, and the dashboards already depend on the server for the stream, status and commands |
| The home address changes (there is no DDNS updater) | Already true for `engine.*`; now every site waits on the A records being updated. A DDNS task with a Vercel API token could come later |
| Upload bandwidth and load | The owner is the main viewer. Next compresses, and the browser caches `/_next/static` for good. The i5 and ~8 GB free in the Docker VM leave room; `docker stats` after phase 1 confirms it |
| The crypto charts' Kraken calls now leave from the server's address, which the engine's REST client also uses | Next's fetch cache (kept on tmpfs) allows at most one call per pair and interval every 30 s (≤15-minute candles) or 2 minutes, a few calls a minute while someone watches a chart. The engine's heaviest REST user, the gap backfill, is paced at one call every 4 s. Watch the crypto log for Kraken rate-limit errors after phase 1 |
| A Docker or WSL reset loses the database volume | Backups every 6 hours on C:, with the restore documented in SERVER.md. The worst case loses 6 hours of paper history |
| A Docker Desktop update brings a Linux kernel from 6.19 through 7.0.13 | MongoDB 8.0 refuses to start on those kernels (a TCMalloc incompatibility). Today's is 6.18.54. Check `docker info`'s kernel before updating Docker Desktop |
| Docker Desktop must be running after a reboot | Already required by the engines (SERVER.md §2); now the sites need it too |
| A minute or two of TLS errors at the DNS switch | The Caddy sites go in right after the switch, not before (§5). Vercel keeps serving visitors whose resolvers haven't switched |

## 13. Decisions for you

1. **The landing page's domain.** `marketbots.vercel.app` is Vercel's own name and can't point here.
   - Recommended: a domain of yours, served here like the dashboards. Name it, for example a subdomain of colinfran.com, which already serves `cron.colinfran.com` from this server. `marketbots.vercel.app` can stay as a one-line redirect to it on Vercel, so links and search results carry over.
   - Or leave the landing page on Vercel as it is: it has no database and no secrets.
2. **Dates:** the web apps on Friday 11-06, at any hour (recommended: they don't touch the engines), and the database cutover on Saturday 11-07 (the stock market is closed, and crypto runs on Azure right up to the stop). Or both on one Saturday.
3. **Backups:** every 6 hours with 7 days kept (recommended: this volume becomes the only copy of the books), or daily with 14 kept, like the wallet.
4. **Deploys:** by name from the server, like the engines (recommended: no new moving parts, and it needs no push). The alternative is automatic deploys on push to `main`: a scheduled task that builds from a clean checkout, never from the working tree where commits are made.
5. **Clean-up windows:** delete the Vercel projects 7 days after phase 1, and Azure 14 days after the cutover, each with your OK (recommended).

## 14. Not in scope

- Moving the stream under each dashboard's own domain and dropping `engine.*`. It would work (Caddy could route `/v1/stream`), but it changes the stream's origin rules for no gain now.
- A CDN in front (Cloudflare), DNS-01 certificates, a DDNS updater.
- A second MongoDB member, or an offsite copy of the backups. Either could come later: `backups\mongo\` is a folder anything can sync.
- Removing the free-tier workarounds (the 15-second caches, one operation at a time, the 4-connection cap). They cost nothing.

## Sources

- This server:
  - 11-03: Azure Monitor `CpuPercent` for the cluster, the cluster's resource properties (West US, Free tier, 32 GB), `docker compose logs` for both engines.
  - 11-05:
    - `docker info` (15.5 GiB, kernel 6.18.54), `docker stats`, `netstat` (ports 3000 and 3010 taken by other stacks; 3101–3103 free).
    - Throwaway containers: the engines and the host agent through `host.docker.internal` (200, 200, 401), the router's loopback to `engine.cryptomarketbot.app` (200), and Caddy's admin API with a forged `Host` header (200).
    - `curl` of each domain (`www` → 307 to the apex).
- Next.js `output: "standalone"` and `outputFileTracingRoot`: https://nextjs.org/docs/app/api-reference/config/next-config-js/output
- Next.js self-hosting (reverse proxy, caching, streaming): https://nextjs.org/docs/app/guides/self-hosting
- CVE-2025-55182, React Server Components RCE (patched Next releases, CISA KEV): https://www.runzero.com/blog/vercel-next-js
- 2026 Next.js security releases affecting self-hosted servers (secondary write-ups; check the official advisories before acting on details): https://lilting.ch/en/articles/nextjs-security-release-16-2-6-15-5-18, https://aicybr.com/blog/nextjs-august-2026-security-release-rce-remediation
- Vercel A records for an apex, CAA: https://vercel.com/kb/guide/a-record-and-caa-with-vercel
- Caddy's admin endpoint options: https://caddyserver.com/docs/caddyfile/options#admin
- MongoDB 8.0 release notes (patch CVEs, the kernel 6.19–7.0.13 startup check): https://www.mongodb.com/docs/manual/release-notes/8.0/
- MongoBleed, CVE-2025-14847 (compression; why it stays off): https://openwall.com/lists/oss-security/2025/12/29/21
- Better Auth's Mongo adapter (transactions only with `client`, which needs a replica set): https://better-auth.com/docs/beta/adapters/mongo.md
- Azure DocumentDB limits (free tier: 32 GiB, no replication, paused after 60 idle days): https://learn.microsoft.com/en-us/azure/documentdb/limitations
- Docker Hub tags: `mongo` 8.0.34 (2026-10-27).
