import { AiRunner as AiRunnerOf, type LocalResearch } from "@mb/engine-kit/ai/runner"
import type { Logger } from "@mb/engine-kit/log"
import type { AiBudget } from "./budget"

export { hasLiveSearch, type ResearchResult } from "@mb/engine-kit/ai/runner"

/**
 * The AI runner (@mb/engine-kit/ai/runner) as crypto runs it: research memos are kept to 12,000
 * characters, and the structured decision streams, as in stock: the partial
 * answer and the reasoning summaries are reported as they arrive, and each attempt is charged the
 * gateway's own cost from its finished steps. The answer is parsed and validated as before.
 * `localUrl` (LLM_URL) lets a model be local/<alias>, on the local model server; `localResearch` lets it research.
 */
export class AiRunner extends AiRunnerOf {
  constructor(budget: AiBudget, log: Logger, enabled: boolean, { localUrl = null, localResearch = null }: { localUrl?: string | null; localResearch?: LocalResearch | null } = {}) {
    super(budget, log, enabled, { stream: true, memoMaxChars: 12_000, localUrl, localResearch })
  }
}
