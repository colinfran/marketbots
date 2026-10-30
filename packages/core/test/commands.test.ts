import { describe, expect, it } from "vitest"
import { agentResumeEntriesCommand, agentReviewCommand } from "../src/commands"

describe("the agent's commands", () => {
  it("wakes the agent for its book and the market, or for up to 5 symbols", () => {
    expect(agentReviewCommand.safeParse({ type: "agent.review" }).success).toBe(true)
    expect(agentReviewCommand.safeParse({ type: "agent.review", symbols: ["SOL/USD", "NVDA", "BRK.B"] }).success).toBe(true)
    expect(agentReviewCommand.safeParse({ type: "agent.review", symbols: ["A", "B", "C", "D", "E", "F"] }).success).toBe(false)
    expect(agentReviewCommand.safeParse({ type: "agent.review", symbols: ["sol usd"] }).success).toBe(false)
  })

  it("resumes the agent's entries", () => {
    expect(agentResumeEntriesCommand.safeParse({ type: "agent.resume_entries" }).success).toBe(true)
  })
})
