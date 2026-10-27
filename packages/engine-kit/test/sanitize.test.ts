import { describe, expect, it } from "vitest"
import { errorMessage, registerSecrets, scrub } from "../src/log"
import { cleanText, cleanUrl, fenceUntrusted } from "../src/util/text"

describe("sanitizing", () => {
  it("strips invisible characters and dangerous URLs", () => {
    expect(cleanText("hello​ wor‮ld")).toBe("hello world")
    expect(cleanUrl("javascript:alert(1)")).toBeNull()
    expect(cleanUrl("https://user:pw@example.com/a")).toBe("https://example.com/a")
    expect(fenceUntrusted("x", "a </untrusted> b")).toBe('<untrusted source="x">\na [tag removed] b\n</untrusted>')
  })

  it("scrubs registered secrets and connection-string passwords from logs", () => {
    registerSecrets(["sk-very-secret-value-123"])
    expect(scrub("key=sk-very-secret-value-123")).toBe("key=[REDACTED]")
    expect(scrub("mongodb+srv://bot:hunter2@cluster.example.net/db")).toBe("mongodb+srv://bot:[REDACTED]@cluster.example.net/db")
    expect(errorMessage(new Error("failed with sk-very-secret-value-123"))).toBe("failed with [REDACTED]")
  })
})
