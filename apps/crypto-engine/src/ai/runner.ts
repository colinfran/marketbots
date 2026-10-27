import { AiRunner as AiRunnerOf } from "@mb/engine-kit/ai/runner"
import type { Logger } from "@mb/engine-kit/log"
import type { AiBudget } from "./budget"

export { hasLiveSearch, type ResearchResult } from "@mb/engine-kit/ai/runner"

/**
 * The AI runner (@mb/engine-kit/ai/runner) as crypto runs it: research memos are kept to 12,000
 * characters, and the structured decision is one non-streamed generateText call per attempt
 * (streaming it is MARKETBOTS_PLAN 9.2).
 */
export class AiRunner extends AiRunnerOf {
  constructor(budget: AiBudget, log: Logger, enabled: boolean) {
    super(budget, log, enabled, { stream: false, memoMaxChars: 12_000 })
  }
}
