import { describe, expect, it } from "vitest"
import { centralBankDecisions, sharedCatalog } from "../src/catalog"

describe("shared catalog", () => {
  it("files each government feed under the bot's hint, and leaves the rest to the lexicon", () => {
    const c = sharedCatalog({ "gov:sec_suspensions": "halt", "gov:doj": "regulatory_action" })
    expect(Object.values(c).map((s) => s.id)).toEqual(Object.keys(c))
    expect(c["gov:sec_suspensions"]).toMatchObject({ kind: "rss", category_hint: "halt", key_env: "SEC_USER_AGENT", tier: 1 })
    expect(c["gov:doj"]).toMatchObject({ kind: "json", category_hint: "regulatory_action" })
    // No hint: no category_hint key at all, as the catalogs wrote it before.
    expect("category_hint" in c["gov:ofac"]).toBe(false)
    expect(c.macro_ff.category_hint).toBe("macro_release")
    expect(c["cb:boj"].refine).toBe(centralBankDecisions)
  })

  it("central banks: rate decisions only, market-wide", () => {
    const kept = centralBankDecisions([{ title: "Bank Rate reduced to 3.75% - November 2026" }, { title: "Monetary policy decisions" }, { title: "Speech by the Governor" }])
    expect(kept.map((i) => i.title)).toEqual(["Bank Rate reduced to 3.75% - November 2026", "Monetary policy decisions"])
    expect(kept[0]).toMatchObject({ symbols: [], marketWide: true, category: "macro_release", kind: "macro" })
  })
})
