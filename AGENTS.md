# AGENTS.md

Conventions for anyone, human or AI agent, changing this repo. Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first, then the design doc of the bot you touch ([docs/CRYPTO.md](docs/CRYPTO.md), [docs/STOCK.md](docs/STOCK.md)). Running the stack: [docs/SERVER.md](docs/SERVER.md).

## Ground rules

1. **Paper trading only.** Never add a live-trading code path.
2. **Never run two engines against the same broker state.** The live engines run in the `marketbots` stack on the server. Anything else that boots an engine (staging, smoke tests, local dev) uses:
   - its own database (`<bot>_staging`, `<bot>_dev`), never the live one;
   - a **copy** of the wallet volume, never the live one (on a fresh database the crypto engine resets whatever wallet it is given);
   - never the live Alpaca keys (one market-data connection per account: they would knock out the live engine's prices).

   `compose.smoke.yml` does all three.
3. **Live settings change only from the dashboard's Admin page** (an audited `settings.update` command). Don't write settings to a live database from scripts. Editing `DEFAULT_SETTINGS` is not a settings change: it doesn't reach a running bot. Staging databases are throwaway, so scripts may change their settings.
4. **Never commit env files** (`.env.crypto`, `.env.stock`, `.env.history`, `.env.host`, `.env.<bot>.local`); only the `.example` files are committed, and they never hold a real value. Never print, log or copy secret values: that includes `docker compose config` without `--quiet` and the env section of `docker inspect`. A new variable goes into the right section (SHARED, ENGINE or DASHBOARD) of the bot's `.env.<bot>.example`, and a SHARED or DASHBOARD one also into the Vercel table in [docs/SERVER.md §3.4](docs/SERVER.md#34-what-goes-into-each-vercel-project).
5. **LF line endings** everywhere (`.gitattributes`: `* text=auto eol=lf`; run `git config core.autocrlf false` in your clone). The engines run in Linux containers, and Dockerfiles, YAML and env files break with CRLF. To copy files from the old repos, `git archive HEAD` the whole tree; never copy from a working tree or archive a `HEAD:<path>` subtree (that skips the root `.gitattributes` and writes CRLF on Windows).
6. **Never touch the paper wallet volume** `cryptomarketbot_kraken-paper`: no `down -v`, no `docker volume rm`, and it stays `external` in `compose.yml` ([docs/SERVER.md §6](docs/SERVER.md#6-the-paper-wallet-volume)). The same goes for `marketbots_history-data`: its news archive is the only copy of news older than 30 days ([§6.4](docs/SERVER.md#64-the-history-stores-volume-and-backups)). Never `docker volume prune`: other stacks share this Docker.
7. **One bot's change never redeploys the other bot.** Deploy engines by name (`docker compose up -d --build <bot>-engine`).
8. **Never run two fan controllers.** The host agent sets the server's motherboard fans only with `FAN_CONTROL=on` in `.env.host`, and only when nothing else does ([docs/SERVER.md §11.4](docs/SERVER.md#114-fans)). After a change to its fan code, restart its task with someone at the machine and check the RPMs follow.

## Package boundaries

Dependency direction:

```
@mb/core ◀── @mb/crypto-core, @mb/stock-core
@mb/core ◀── @mb/engine-kit ◀── @mb/wire, @mb/history
@mb/wire ◀── @mb/agent
@mb/core ◀── @mb/ui, @mb/web-kit
```

(`A ◀── B` means B imports A.) Apps depend on packages; packages never import apps. **No crypto package or app ever imports a stock one, or the reverse.**

ESLint enforces this with `no-restricted-imports`, built by `boundaries(owner)` in [packages/config/eslint.mjs](packages/config/eslint.mjs). Each package's `eslint.config.mjs` names its owner:

- `nodeConfig("crypto")` / `nodeConfig("stock")` for engines and bot core packages, `nextConfig("crypto")` / `nextConfig("stock")` for dashboards. Bot code may not import an app, or any `@mb/<other bot>-*` package.
- `nodeConfig("<name>")` for a shared package (`core`, `engine-kit`, `wire`, `history`, `agent`, `ui`, `web-kit`). It may import only itself, `@mb/config` and its entry in the `SHARED` map in `eslint.mjs`.
- `nodeConfig("host-agent")` for the Windows host agent (`apps/host-agent`): it imports only `@mb/core` (its entry in `SITES`).

Beyond what the rule checks:

- A bot's core package depends only on `@mb/core` (the rule would allow any shared package there; don't use that).
- Import code by package name, never by a relative path into another package (`../../packages/...`): relative paths bypass the rule. Config files (`tsconfig.json` `extends`) are the exception.
- Don't disable the rule. If code is needed across a boundary, it belongs in a shared package lower down.

## Adding shared code

The shared packages are `packages/config`, `packages/core`, `packages/engine-kit`, `packages/wire`, `packages/history`, `packages/agent`, `packages/ui` and `packages/web-kit` ([docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#shared-code)).

1. **Pick the package**: `core` (pure, no I/O), `engine-kit` (engine runtime), `wire` (news engine), `history` (the history store), `agent` (the agent runtime), `ui` (client-safe React), `web-kit` (server-only dashboard helpers).
2. **Share only what both bots mean the same thing by.** If sharing would need a flag that switches between two behaviors, keep the code per bot. Pass what genuinely differs (a constant, an HMAC prefix, a time zone, a Discord username) in as a parameter; no `if (bot === "crypto")` in shared code, and no bot-specific constants.
3. **A new package** `packages/<name>/` (copy `packages/crypto-core` as the template):
   - `package.json`: `"name": "@mb/<name>"`, `"private": true`, `"type": "module"`, `"exports": { "./*": "./src/*.ts" }`, `test` / `typecheck` / `lint` scripts, and `"@mb/config": "workspace:*"` in devDependencies.
   - `tsconfig.json` extending `../../packages/config/tsconfig.base.json`.
   - `eslint.config.mjs`: `export default nodeConfig("<name>")`, and the name with its allowed imports in `SHARED` in `packages/config/eslint.mjs` if it isn't there yet.
   - `vitest.config.mts` if it has tests (`@mb/config/vitest.mjs` has the engine and web presets).
   - Then `pnpm install` to link it.
4. **Consumers** add `"@mb/<name>": "workspace:*"` to their dependencies and import by subpath: `@mb/core/math` is `packages/core/src/math.ts`.
   - Packages ship TypeScript source, with no build step and no `dist/`.
   - Engines need nothing more: esbuild bundles the source, and the engine Dockerfiles copy `packages/` whole.
   - Dashboards also list the package in `transpilePackages` in `next.config.ts`. Vercel builds an app when a package in its `dependencies` changes, so the dependency entry is what matters ([docs/SERVER.md §8.2](docs/SERVER.md#82-skipping-unaffected-builds)).
   - For `@mb/ui`, each app's `globals.css` also needs an `@source` for the package: Tailwind v4 doesn't scan workspace symlinks by itself.
5. **Update the tables** in docs/ARCHITECTURE.md.

**No mirrored code is left:** the news-engine files that used to be kept in sync by hand now live once in `packages/wire`. If you find yourself making the same change in both bots, it probably belongs in a shared package.

## Refactors preserve behavior, and that is proven

- **Move first, refactor second.** Move code as-is into its package, then parameterize, one deployable step at a time.
- **Contract snapshots** under `contracts/<bot>/` record today's behavior: `DEFAULT_SETTINGS`, the settings and command JSON schemas, `INDEXES`, event type lists, the wire catalog, rendered prompts for fixed contexts, and parsed items for every source fixture. The tests that produce and compare them live with each engine's tests (e.g. `apps/crypto-engine/test/contracts/`) and run in `pnpm test`.
- **A snapshot diff means a behavior change.** Stop. Revert it, or make the change its own owner-approved commit with a reason. Never regenerate snapshots to make a refactor pass.
- **Regenerate only for an approved behavior change**, and commit the snapshot diff with it:

  ```bash
  UPDATE_CONTRACTS=1 pnpm --filter @mb/crypto-engine test
  ```

  In PowerShell: `$env:UPDATE_CONTRACTS = "1"; pnpm --filter @mb/crypto-engine test; Remove-Item Env:UPDATE_CONTRACTS`.
- **Test counts** never go down (1,104 across the repo on 2026-10-30: 1,072 after the timed cycles, the seed, the backtester, the core book and the old AI runner were removed with their tests, then the host agent's 32).
- A commit that changes behavior names the change in its message.

## Gate, commit, deploy

After each change:

1. **Gate**: `pnpm typecheck && pnpm test && pnpm lint && pnpm build`, all green (the baseline had no warnings; keep it that way). (Git Bash or PowerShell 7; Windows PowerShell 5.1 has no `&&`, so run them one by one there.) Refactors also need unchanged contract snapshots, and a change to engine startup, a Dockerfile or `compose.yml` a boot test of the new engine images with `compose.smoke.yml` ([docs/SERVER.md §6.3](docs/SERVER.md#63-boot-testing-new-images-against-a-copy)).
2. **One commit.** The owner pushes to GitHub; a push to `main` deploys the dashboards whose paths changed.
3. **Deploy the engines** whose images changed: `docker compose up -d --build <bot>-engine` (a change in a package both engines use means both). Timing and the after-deploy checks: [docs/SERVER.md §5](docs/SERVER.md#5-everyday-operations). Never deploy an engine in the middle of an agent episode. The host agent isn't in compose: build it and restart its task ([§11.3](docs/SERVER.md#113-deploy-restart-logs)).

## Docs

- A bot's behavior changes → its design doc (docs/CRYPTO.md, docs/STOCK.md).
- Shared packages, layout or topology change → docs/ARCHITECTURE.md.
- Stack, env files, deploys or Vercel change → docs/SERVER.md.
- Each web app keeps its own `apps/*-web/AGENTS.md` (Next.js notes). `next dev` rewrites its block; leave those files alone.

## Notes for agents on the Windows server

- The default shell is Windows PowerShell 5.1; Git Bash is also available. Bash heredocs that contain backticks or `${` get mangled by the tool layer: write files with an editor or file-writing tool.
- Read-only Docker commands (`docker ps`, `docker compose ps`, `docker compose logs`, `docker volume ls`) are always fine. Anything that stops, starts or recreates a `marketbots-*` container is a deploy and follows the rules above.
