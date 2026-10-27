import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import { createRobots, isAllowed, parseRobots } from "../robots.mjs"

const fixture = readFileSync(new URL("./fixtures/robots.txt", import.meta.url), "utf8")

describe("parseRobots", () => {
  it("keeps only the User-agent: * group", () => {
    const rules = parseRobots(fixture)
    assert.deepEqual(
      rules.map((r) => `${r.allow ? "allow" : "disallow"} ${r.pattern}`),
      ["disallow /search", "disallow /private/", "disallow /*.pdf$", "disallow /markets/", "allow /markets/news/", "disallow /api", "allow /api/public"],
    )
  })

  it("treats consecutive User-agent lines as one group", () => {
    const rules = parseRobots("User-agent: foo\nUser-agent: *\nDisallow: /x\n\nUser-agent: bar\nDisallow: /y")
    assert.deepEqual(rules, [{ allow: false, pattern: "/x" }])
  })

  it("has no rules without a * group, or for an HTML soft 404", () => {
    assert.deepEqual(parseRobots("User-agent: Googlebot\nDisallow: /"), [])
    assert.deepEqual(parseRobots("<!doctype html><html><body><h1>Page not found</h1></body></html>"), [])
  })
})

describe("isAllowed", () => {
  const rules = parseRobots(fixture)
  const cases = [
    ["/", true],
    ["/news/2026/10/26/story", true],
    ["/search", false],
    ["/search?q=bitcoin", false],
    ["/private/notes", false],
    ["/markets/prices", false],
    ["/markets/news/fed-holds", true],
    ["/files/report.pdf", false],
    ["/files/report.pdf?download=1", true],
    ["/api/quotes", false],
    ["/api/public/quotes", true],
    ["/robots.txt", true],
  ]
  for (const [path, expected] of cases) {
    it(`${path} → ${expected ? "allowed" : "disallowed"}`, () => assert.equal(isAllowed(rules, path), expected))
  }

  it("lets Allow win a tie of equal length", () => {
    assert.equal(isAllowed(parseRobots("User-agent: *\nDisallow: /page\nAllow: /page"), "/page"), true)
  })

  it("Disallow: / blocks everything; no rules allow everything", () => {
    assert.equal(isAllowed(parseRobots("User-agent: *\nDisallow: /"), "/anything"), false)
    assert.equal(isAllowed([], "/anything"), true)
  })
})

describe("createRobots", () => {
  const robotsFetch = (respond) => {
    const calls = []
    const fetch = async (url) => {
      calls.push(String(url))
      return respond(String(url))
    }
    return { fetch, calls }
  }

  it("fetches robots.txt once per origin and caches it for 24 h", async () => {
    let clock = 0
    const { fetch, calls } = robotsFetch(() => new Response(fixture, { headers: { "content-type": "text/plain" } }))
    const robots = createRobots({ fetch, now: () => clock })
    assert.equal(await robots.allowed("https://www.newsroom.example/markets/prices"), false)
    assert.equal(await robots.allowed("https://www.newsroom.example/markets/news/a"), true)
    assert.equal(await robots.allowed("https://www.newsroom.example/search?q=1"), false)
    assert.deepEqual(calls, ["https://www.newsroom.example/robots.txt"])
    clock += 24 * 3_600_000 - 1
    await robots.allowed("https://www.newsroom.example/")
    assert.equal(calls.length, 1)
    clock += 2
    await robots.allowed("https://www.newsroom.example/")
    assert.equal(calls.length, 2)
  })

  it("shares one fetch between concurrent lookups", async () => {
    const { fetch, calls } = robotsFetch(() => new Response("User-agent: *\nDisallow: /x"))
    const robots = createRobots({ fetch })
    const answers = await Promise.all([robots.allowed("https://a.example/x"), robots.allowed("https://a.example/y"), robots.allowed("https://b.example/x")])
    assert.deepEqual(answers, [false, true, false])
    assert.equal(calls.length, 2)
  })

  it("treats an unreachable, missing or failing robots.txt as allowed", async () => {
    const { fetch } = robotsFetch((url) => {
      if (url.startsWith("https://down.example")) throw new TypeError("fetch failed")
      if (url.startsWith("https://missing.example")) return new Response("nope", { status: 404 })
      return new Response("oops", { status: 503 })
    })
    const robots = createRobots({ fetch })
    assert.equal(await robots.allowed("https://down.example/a"), true)
    assert.equal(await robots.allowed("https://missing.example/a"), true)
    assert.equal(await robots.allowed("https://broken.example/a"), true)
  })
})
