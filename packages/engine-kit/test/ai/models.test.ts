import { describe, expect, it } from "vitest"
import { isLocalModel } from "../../src/ai/models"

describe("local models", () => {
  it("are the local/ ids", () => {
    expect(["local/qwen", "spacexai/grok-4.7", "localhost/x"].map(isLocalModel)).toEqual([true, false, false])
  })
})
