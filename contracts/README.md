# Contract snapshots

These files record what both bots do today. They were generated from the code as it was moved in unchanged (MARKETBOTS_PLAN §2 rule 2, task 2.5). The refactors in Phases 5–8 must leave every file here byte-identical.

## The rule

The tests compare what the code produces now with these files, and fail on any difference.

**A diff means behavior changed.** Do one of two things:

- Revert the change, or
- Move it to Phase 9 (one approved change per commit) with a reason, then regenerate.

Never regenerate just to make a refactor pass.

## Running and regenerating

The tests run as part of each engine's normal suite (`pnpm test`).

To rewrite the files after an approved change:

```sh
UPDATE_CONTRACTS=1 pnpm --filter @mb/crypto-engine test
UPDATE_CONTRACTS=1 pnpm --filter @mb/stock-engine test
```

Regenerating also deletes snapshots that nothing produces any more. Review the diff before you commit.

Output format:

- JSON: `JSON.stringify(value, null, 2)` plus a final newline, with keys in the order the code produces them.
- Dates as ISO strings, Maps as objects, Sets as arrays.
- LF line endings.

## Where the tests live

| Bot | Tests | Snapshots |
| --- | --- | --- |
| crypto | `apps/crypto-engine/test/contracts/*.test.ts` | `contracts/crypto/` |
| stock | `apps/stock-engine/test/contracts/*.test.ts` | `contracts/stock/` |

Each folder has a `snapshot.ts` helper and four test files:

- `schemas.test.ts`
- `catalog.test.ts`
- `sources.test.ts`
- `prompts.test.ts`

None of them use the database.

## What each file is

These are the same for both bots.

| File | What it holds | Test |
| --- | --- | --- |
| `default-settings.json` | `DEFAULT_SETTINGS` | schemas |
| `settings.schema.json` | The settings zod schema as JSON Schema (`z.toJSONSchema`, zod 4). It has an `input` and an `output` view; only `output` sets `additionalProperties: false`. | schemas |
| `settings-validation.json` | What the settings schema accepts or rejects, and the error it gives: the defaults, each `superRefine` rule broken once, and unknown keys. Refinements have no JSON Schema form, so this file covers them. | schemas |
| `commands.schema.json` | The dashboard-to-engine command schema as JSON Schema, plus `COMMAND_LABEL`. Crypto also has the backtest parameter schema and options. | schemas |
| `db.json` | `COLLECTIONS` (the collection-name map) and `INDEXES`. Crypto also has the terminal order statuses; stock has the filled-orders filter. | schemas |
| `events.json` | Every event type: the keys of `EventDataMap`, read with the TypeScript checker, and each type's data keys (`?` marks optional ones). Also `OWNER_ONLY_EVENTS`, `EPHEMERAL_EVENTS`, the event and stream protocol versions, and the envelope and client-frame schemas. | schemas |
| `constants.json` | Plain domain constants: strategies or setups, option constants (stock), wire kinds, category severity bases, tier factors, notable reasons. | schemas |
| `ai.schema.json` | The structured-output schemas the AI must answer with, and their enums. Crypto: decision report and seed allocation. Stock: bot report, decision and option order. | schemas |
| `wire-catalog.json` | Every news source as `main.ts` hands it to the Wire, in catalog order. Each entry has its id, kind, url, interval, tier, and the other plain fields that define behavior. Functions are listed by name, with two exceptions: `urlFor` is called for two sample symbols, and `headers` is called with an env whose every variable reads `<NAME>`. | catalog |
| `parsed/<fixture>.json` | One file per saved source payload in `apps/<bot>-engine/test/fixtures/wire/`: what the source's parser makes of it. See below. | sources |
| `prompts/*.txt` | Rendered prompts for a fixed, realistic cycle: research, gap-fill, event section, wire dossier, decision system and user prompts, and the seed prompts. Every text file ends with one added newline. | prompts |
| `prompts/meta.json` | Prompt versions, the owner's seed lean, and the inputs derived from the fixtures: regime, event and seed candidates (crypto), and the dossier's item lists. | prompts |

### Parsed source fixtures

Each file names the fixture and the parser that ran.

- **Catalog parser first.** When the fixture belongs to a catalog entry, that entry's own parser runs:
  - rss or telegram parse, then `refine`
  - statuspage
  - json `map`
  - diff `entries` and `describe`
  - html `mapHtml`
- **Otherwise,** the exported source function that the entry's poller calls.
- **Watched metrics.** Some sources feed a `MetricWatcher`. On a fresh watcher the first reading is only a baseline, so these files also list every reading the parser extracted.
- **Fixed inputs.** The clock and symbol sets are fixed in the test files.

If a fixture is added, its test fails until the fixture gets a parser entry and a snapshot.

### Prompt fixtures

The fixture contexts are written out in the `prompts.test.ts` files and are fully deterministic: the clock is pinned and there is no randomness. They go through the real helpers, such as:

- `assembleDossier` and `eventSection`
- crypto: `classifyRegime`, `featuresForPrompt`, `eventCandidates`, `seedCandidate`

So a refactor of those helpers shows up here too.

## Known limits

- **Repair schemas aren't snapshotted.** The lenient schemas in `src/ai/repair.ts` (both bots) are not exported, and they are built from `z.preprocess`. Their behavior is covered by the repair unit tests.
- **Some outputs are legitimately empty.** For example, a status page with no incidents, or a watcher's first, baseline reading. The intermediate data is kept wherever the parser exposes it.
- **Stock times depend on Node's ICU data.** Stock prompts format times with `Intl` (`America/New_York`). A Node upgrade that changes ICU output could change those bytes without a code change; that is the one case where regenerating without a Phase 9 entry is fine, after checking that the diff is only date formatting.
