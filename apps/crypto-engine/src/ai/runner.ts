import { AiRunner as AiRunnerOf, type LocalResearch } from "@mb/engine-kit/ai/runner"
import type { Logger } from "@mb/engine-kit/log"
import type { AiBudget } from "./budget"

export type { ResearchResult } from "@mb/engine-kit/ai/runner"

/**
 * The AI runner (@mb/engine-kit/ai/runner) as crypto runs it: research memos are kept to 12,000
 * characters, and the structured decision streams, as in stock: the partial answer and the model's
 * thinking are reported as they arrive. The answer is parsed and validated as before. `localUrl`
 * (LLM_URL) is the model server; `localResearch` is how the model researches.
 */
export class AiRunner extends AiRunnerOf {
  constructor(budget: AiBudget, log: Logger, { localUrl = null, localResearch = null }: { localUrl?: string | null; localResearch?: LocalResearch | null } = {}) {
    super(budget, log, { stream: true, memoMaxChars: 12_000, localUrl, localResearch })
  }
}
