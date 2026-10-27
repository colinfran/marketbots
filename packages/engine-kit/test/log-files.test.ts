import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { dailyLogFiles } from "../src/log"

let dir: string
let clock: Date
const now = () => clock
const read = (day: string) => readFileSync(join(dir, `${day}.log`), "utf8")

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mb-logs-"))
  clock = new Date("2026-10-27T12:00:00Z")
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe("daily log files", () => {
  it("appends to the day's file, and a new writer (the next container) carries on in it", () => {
    const first = dailyLogFiles(dir, { now })
    first('{"msg":"a"}')
    first('{"msg":"b"}')
    const next = dailyLogFiles(dir, { now })
    next('{"msg":"c"}')
    expect(read("2026-10-27")).toBe('{"msg":"a"}\n{"msg":"b"}\n{"msg":"c"}\n')
  })

  it("starts a new file at UTC midnight and deletes day files past the retention", () => {
    for (const name of ["2026-07-29.log", "2026-07-30.log", "notes.txt"]) writeFileSync(join(dir, name), "old\n")
    const write = dailyLogFiles(dir, { now, retentionDays: 90 })
    clock = new Date("2026-10-27T23:59:59Z")
    write("late")
    clock = new Date("2026-10-28T00:00:00Z")
    write("early")
    expect(read("2026-10-27")).toBe("late\n")
    expect(read("2026-10-28")).toBe("early\n")
    // 90 days before 2026-10-28 is 2026-07-30, the oldest day kept; files that aren't day files are left alone.
    expect(readdirSync(dir).sort()).toEqual(["2026-07-30.log", "2026-10-27.log", "2026-10-28.log", "notes.txt"])
  })

  it("stops a day's file at maxBytes with one notice, and starts again the next day", () => {
    const write = dailyLogFiles(dir, { now, maxBytes: 200 })
    for (let i = 0; i < 20; i++) write(`{"msg":"line ${i}"}`)
    const lines = read("2026-10-27").trim().split("\n")
    expect(lines.at(-1)).toContain("log file full")
    expect(lines.filter((l) => l.includes("log file full"))).toHaveLength(1)
    const size = statSync(join(dir, "2026-10-27.log")).size
    // A new writer on a full file adds nothing, not even a second notice.
    dailyLogFiles(dir, { now, maxBytes: 200 })("more")
    expect(statSync(join(dir, "2026-10-27.log")).size).toBe(size)
    clock = new Date("2026-10-28T00:00:01Z")
    write("next day")
    expect(read("2026-10-28")).toBe("next day\n")
  })

  it("never throws when the folder can't be written, and says so once on stdout", () => {
    const printed: string[] = []
    vi.spyOn(process.stdout, "write").mockImplementation((line) => {
      printed.push(String(line))
      return true
    })
    writeFileSync(join(dir, "blocker"), "")
    const write = dailyLogFiles(join(dir, "blocker", "logs"), { now })
    expect(() => {
      write("one")
      write("two")
    }).not.toThrow()
    expect(printed).toHaveLength(1)
    expect(JSON.parse(printed[0])).toMatchObject({ level: "warn", msg: "log file not writable; logging to stdout only" })
  })
})
