import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import { capText, createExtractor, extractArticle, parseExtractJob, privateHost, proseShare, skippedDomain, toPlainText } from "../extract.mjs"
import { createRobots } from "../robots.mjs"
import { parseHTML } from "linkedom"

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")
const HTML = { "content-type": "text/html; charset=utf-8" }

/**
 * A fake fetch over a URL → response table. A value is { body, status?, headers? }, a function
 * returning a Response, or an Error to throw. Unknown URLs (robots.txt included) are 404.
 */
const fakeWeb = (routes) => {
  const calls = []
  const fetch = async (url, init) => {
    const key = String(url)
    calls.push(key)
    const route = routes[key]
    if (route instanceof Error) throw route
    if (typeof route === "function") return route(init)
    if (!route) return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } })
    return new Response(route.body ?? "", { status: route.status ?? 200, headers: route.headers ?? HTML })
  }
  return { fetch, calls, pages: () => calls.filter((u) => !u.endsWith("/robots.txt")) }
}

const fakeRender = (pages) => {
  const calls = []
  const render = async (url, caller) => {
    calls.push({ url, caller })
    const page = pages[url]
    if (page instanceof Error) throw page
    if (!page) throw new Error("net::ERR_NAME_NOT_RESOLVED")
    return { status: page.status ?? 200, url: page.url ?? url, html: page.html }
  }
  return { render, calls }
}

const setup = (routes, renderPages = {}) => {
  const web = fakeWeb(routes)
  const r = fakeRender(renderPages)
  const extract = createExtractor({ fetch: web.fetch, robots: createRobots({ fetch: web.fetch }), render: r.render })
  const run = (body) => {
    const { job, error } = parseExtractJob(JSON.stringify(body))
    assert.equal(error, undefined)
    return extract(job, "crypto")
  }
  return { run, web, renders: r.calls }
}

const ETF_URL = "https://www.ledgerdaily.example/markets/2026/10/24/spot-ether-etfs-record-inflows/"
const SHELL_URL = "https://app.chainpulse.example/news/orbitex-exploit"

describe("extractArticle", () => {
  it("pulls the article, metadata and paragraphs out of a busy news page", () => {
    const a = extractArticle(fixture("ledger-etf.html"), ETF_URL)
    assert.equal(a.title, "Spot Ether ETFs Log Record $1.2B Weekly Inflows as Staking Approval Nears")
    assert.equal(a.byline, "Dana Whitfield")
    assert.equal(a.published, "2026-10-24T14:05:00.000Z")
    assert.equal(a.lang, "en")
    assert.equal(a.words, 332)
    assert.ok(a.text.startsWith("U.S. spot ether exchange-traded funds took in $1.2 billion"))
    assert.ok(a.text.endsWith("meet redemptions within a day."))
    assert.equal(a.text.split("\n\n").length, 10)
    for (const noise of ["cookies", "Accept all", "Read more", "Newsletters", "All rights reserved", "track()", "__ADS__", "display:flex"]) {
      assert.ok(!a.text.includes(noise), `text contains "${noise}"`)
    }
    assert.ok(!/[ \t]{2,}/.test(a.text), "runs of spaces are collapsed")
  })

  it("prefers meta article:published_time and reads <html lang> with a region", () => {
    const a = extractArticle(fixture("wire-fed.html"), "https://www.wiredesk.example/markets/us/fed-collins-2026-10-26/")
    assert.equal(a.published, "2026-10-26T13:12:44.512Z")
    assert.equal(a.lang, "en-US")
    assert.equal(a.byline, "Ann Kowalski")
    assert.match(a.title, /^Fed's Collins says another cut is possible/)
    assert.ok(a.text.includes("the 3.75%-4.00% range"))
    assert.ok(a.text.includes("U.S. employers added 61,000 jobs in September"))
    assert.ok(!a.text.includes("Oil steadies"), "recommended links are dropped")
  })

  it("falls back to <time datetime>, keeps <br> as a line break and list items as paragraphs", () => {
    const a = extractArticle(fixture("blog-earnings.html"), "https://chipnotes.example/2026/10/northwind-q3")
    assert.equal(a.published, "2026-10-24T01:30:00.000Z")
    assert.equal(a.lang, "en-GB")
    assert.equal(a.byline, "R. Okafor")
    assert.ok(a.text.includes("analysts had expected.\nAdjusted earnings per share came in at $1.87"))
    assert.ok(a.text.includes("\n\nGross margin: 61.4%, up from 57.9%.\n\n"))
    assert.ok(a.text.includes("Data center $2.61B $1.65B"))
    assert.ok(!a.text.includes("Great write-up"), "comments are dropped")
  })

  it("finds next to nothing in a JavaScript shell", () => {
    const a = extractArticle(fixture("js-shell.html"), SHELL_URL)
    assert.ok(!a || a.words < 10)
  })

  it("drops navigation, skip links and consent banners", () => {
    const a = extractArticle(fixture("teaser.html"), "https://wire.example/a")
    for (const noise of ["Skip to main content", "Home", "Sports", "cookies", "privacy settings"]) {
      assert.ok(!a.text.includes(noise), `text contains "${noise}"`)
    }
    assert.ok(a.text.includes("S&P 500 futures rose 0.7%"))
  })

  it("returns null for an empty page", () => {
    assert.equal(extractArticle("", "https://x.example/"), null)
  })
})

describe("toPlainText and capText", () => {
  it("collapses inline whitespace and separates blocks", () => {
    const { document } = parseHTML("<div><h2>Head  line</h2><p>One\n   two <b>three</b></p><p>Four<script>x()</script></p></div>")
    assert.equal(toPlainText(document.querySelector("div")), "Head line\n\nOne two three\n\nFour")
  })

  it("measures how much of a text is prose", () => {
    const sentence = "The exchange said on Monday it would cover all customer losses from its own reserves."
    assert.equal(proseShare(`${sentence}\n\n${sentence}`), 1)
    assert.equal(proseShare("Home\n\nNews\n\nMarkets\n\nAbout us"), 0)
    assert.equal(proseShare(""), 0)
  })

  it("cuts at a word boundary and reports truncation", () => {
    assert.deepEqual(capText("short", 100), { text: "short", truncated: false })
    const { text, truncated } = capText("alpha beta gamma delta", 13)
    assert.equal(truncated, true)
    assert.equal(text, "alpha beta")
  })
})

describe("parseExtractJob", () => {
  it("applies defaults and normalizes the request", () => {
    const { job } = parseExtractJob(JSON.stringify({ url: "https://Example.com/a#frag", skip_domains: ["WWW.CoinDesk.com", "*.theblock.co", "not a domain", 7] }))
    assert.deepEqual(job, { url: "https://example.com/a", render: "auto", skip_domains: ["coindesk.com", "theblock.co"], max_chars: 20_000 })
  })

  it("clamps max_chars", () => {
    assert.equal(parseExtractJob(JSON.stringify({ url: "https://a.example/", max_chars: 5 })).job.max_chars, 200)
    assert.equal(parseExtractJob(JSON.stringify({ url: "https://a.example/", max_chars: 1e9 })).job.max_chars, 100_000)
    assert.equal(parseExtractJob(JSON.stringify({ url: "https://a.example/", max_chars: 1234.7 })).job.max_chars, 1234)
  })

  it("rejects bad requests", () => {
    assert.equal(parseExtractJob("{").error, "body is not JSON")
    assert.equal(parseExtractJob(JSON.stringify({ url: "nope" })).error, "url is not a URL")
    assert.equal(parseExtractJob(JSON.stringify({ url: "ftp://a.example/x" })).error, "only http and https URLs are extracted")
    assert.match(parseExtractJob(JSON.stringify({ url: "https://a.example/", render: "sometimes" })).error, /render must be/)
  })
})

describe("skippedDomain and privateHost", () => {
  it("matches paywalled domains and their subdomains only", () => {
    assert.equal(skippedDomain("www.wsj.com"), "wsj.com")
    assert.equal(skippedDomain("markets.ft.com"), "ft.com")
    assert.equal(skippedDomain("ft.com"), "ft.com")
    assert.equal(skippedDomain("www.bloomberg.com"), "bloomberg.com")
    assert.equal(skippedDomain("seekingalpha.com"), "seekingalpha.com")
    assert.equal(skippedDomain("softcom.example"), null)
    assert.equal(skippedDomain("microsoft.com"), null)
    assert.equal(skippedDomain("www.coindesk.com", ["coindesk.com"]), "coindesk.com")
  })

  it("refuses loopback, private, link-local and single-label hosts", () => {
    for (const h of ["localhost", "crypto-engine", "llm", "127.0.0.1", "10.1.2.3", "172.20.0.5", "192.168.1.10", "169.254.169.254", "[::1]", "host.docker.internal", "printer.local"]) {
      assert.equal(privateHost(h), true, h)
    }
    for (const h of ["www.coindesk.com", "8.8.8.8", "172.32.0.1", "news.example"]) assert.equal(privateHost(h), false, h)
  })
})

describe("createExtractor", () => {
  it("returns a plain-fetched article without rendering", async () => {
    const { run, renders } = setup({ [ETF_URL]: { body: fixture("ledger-etf.html") } })
    const r = await run({ url: ETF_URL })
    assert.equal(r.status, "ok")
    assert.equal(r.url, ETF_URL)
    assert.equal(r.final_url, ETF_URL)
    assert.equal(r.rendered, false)
    assert.equal(r.truncated, false)
    assert.equal(r.words, 332)
    assert.equal(r.byline, "Dana Whitfield")
    assert.equal(r.published, "2026-10-24T14:05:00.000Z")
    assert.equal(r.lang, "en")
    assert.equal(renders.length, 0)
  })

  it("sends a browser User-Agent", async () => {
    let ua = null
    const { run } = setup({
      [ETF_URL]: (init) => {
        ua = init.headers["user-agent"]
        return new Response(fixture("ledger-etf.html"), { headers: HTML })
      },
    })
    await run({ url: ETF_URL })
    assert.match(ua, /^Mozilla\/5\.0 .* Chrome\/\d+/)
  })

  it("skips paywalled domains and subdomains without fetching anything", async () => {
    const { run, web } = setup({})
    for (const [url, d] of [
      ["https://www.wsj.com/articles/fed-holds-rates-123", "wsj.com"],
      ["https://markets.ft.com/data/a", "ft.com"],
      ["https://www.nytimes.com/2026/10/26/business/x.html", "nytimes.com"],
      ["https://www.economist.com/finance/2026/10/26/x", "economist.com"],
      ["https://www.barrons.com/articles/x", "barrons.com"],
    ]) {
      assert.deepEqual(await run({ url }), { status: "skipped", reason: `skip list: ${d}` })
    }
    assert.equal(web.calls.length, 0)
  })

  it("skips the caller's skip_domains too", async () => {
    const { run, web } = setup({})
    const r = await run({ url: "https://www.coindesk.com/markets/2026/10/26/x", skip_domains: ["coindesk.com"] })
    assert.deepEqual(r, { status: "skipped", reason: "skip list: coindesk.com" })
    assert.equal(web.calls.length, 0)
  })

  it("refuses private addresses", async () => {
    const { run, web } = setup({})
    assert.equal((await run({ url: "http://crypto-engine:8787/health" })).status, "skipped")
    assert.equal((await run({ url: "http://127.0.0.1:8790/health" })).status, "skipped")
    assert.equal(web.calls.length, 0)
  })

  it("honours robots.txt and never fetches a disallowed page", async () => {
    const base = "https://www.newsroom.example"
    const { run, web } = setup({
      [`${base}/robots.txt`]: { body: fixture("robots.txt"), headers: { "content-type": "text/plain" } },
      [`${base}/markets/news/etf-flows`]: { body: fixture("ledger-etf.html") },
    })
    const refused = await run({ url: `${base}/markets/prices/btc` })
    assert.deepEqual(refused, { status: "skipped", reason: "robots.txt disallows /markets/prices/btc" })
    assert.equal(web.pages().length, 0)
    const allowed = await run({ url: `${base}/markets/news/etf-flows` })
    assert.equal(allowed.status, "ok")
    assert.equal(web.calls.filter((u) => u.endsWith("/robots.txt")).length, 1, "robots.txt is cached")
  })

  it("renders a short JavaScript page in auto mode", async () => {
    const { run, renders } = setup({ [SHELL_URL]: { body: fixture("js-shell.html") } }, { [SHELL_URL]: { html: fixture("js-shell-rendered.html") } })
    const r = await run({ url: SHELL_URL })
    assert.equal(r.status, "ok")
    assert.equal(r.rendered, true)
    assert.equal(r.words, 188)
    assert.equal(r.byline, "Theo Marchetti")
    assert.equal(r.title, "Exchange halts withdrawals after $85M hot-wallet exploit")
    assert.deepEqual(renders, [{ url: SHELL_URL, caller: "crypto" }])
  })

  it("does not render in never mode", async () => {
    const { run, renders } = setup({ [SHELL_URL]: { body: fixture("js-shell.html") } }, { [SHELL_URL]: { html: fixture("js-shell-rendered.html") } })
    const r = await run({ url: SHELL_URL, render: "never" })
    assert.equal(r.status, "failed")
    assert.match(r.reason, /^too little text \(\d words\)$/)
    assert.equal(renders.length, 0)
  })

  it("renders straight away in always mode", async () => {
    const { run, web, renders } = setup({}, { [SHELL_URL]: { html: fixture("js-shell-rendered.html") } })
    const r = await run({ url: SHELL_URL, render: "always" })
    assert.equal(r.status, "ok")
    assert.equal(r.rendered, true)
    assert.equal(web.pages().length, 0)
    assert.equal(renders.length, 1)
  })

  it("keeps a medium-length plain article when the render fails", async () => {
    const paragraphs = Array.from({ length: 6 }, (_, i) => `<p>Paragraph ${i + 1} of a short wire brief says the token fell 4% after the listing news broke this morning.</p>`).join("")
    const url = "https://brief.example/a"
    const { run } = setup({ [url]: { body: `<html lang="en"><body><article><h1>Brief</h1>${paragraphs}</article></body></html>` } }, { [url]: new Error("busy: 16 renders queued (8 from crypto)") })
    const r = await run({ url })
    assert.equal(r.status, "ok")
    assert.equal(r.rendered, false)
    assert.ok(r.words >= 50 && r.words < 150, `${r.words} words`)
  })

  it("fails with the render error when there is nothing to fall back on", async () => {
    const { run } = setup({ [SHELL_URL]: { body: fixture("js-shell.html") } }, { [SHELL_URL]: new Error("busy: 16 renders queued (8 from crypto)") })
    assert.deepEqual(await run({ url: SHELL_URL }), { status: "failed", reason: "render failed: busy: 16 renders queued (8 from crypto)" })
  })

  it("renders after a 403 but not after a 404", async () => {
    const blocked = "https://blocked.example/story"
    const gone = "https://gone.example/story"
    const { run, renders } = setup(
      { [blocked]: { status: 403, body: "Forbidden" }, [gone]: { status: 404, body: "Not found" } },
      { [blocked]: { html: fixture("js-shell-rendered.html") } },
    )
    const r = await run({ url: blocked })
    assert.equal(r.status, "ok")
    assert.equal(r.rendered, true)
    assert.deepEqual(await run({ url: gone }), { status: "failed", reason: "http 404" })
    assert.equal(renders.length, 1)
  })

  it("follows redirects, checking each hop", async () => {
    const short = "https://lnk.example/abc"
    const final = "https://www.ledgerdaily.example/markets/a"
    const { run, web } = setup({
      [short]: { status: 301, headers: { location: "https://www.ledgerdaily.example/go" } },
      "https://www.ledgerdaily.example/go": { status: 302, headers: { location: "/markets/a#top" } },
      [final]: { body: fixture("ledger-etf.html") },
    })
    const r = await run({ url: short })
    assert.equal(r.status, "ok")
    assert.equal(r.url, short)
    assert.equal(r.final_url, final)
    assert.deepEqual(web.pages(), [short, "https://www.ledgerdaily.example/go", final])
  })

  it("skips a redirect to a paywalled domain without fetching it", async () => {
    const { run, web } = setup({ "https://news.example/r/1": { status: 301, headers: { location: "https://www.ft.com/content/abc" } } })
    assert.deepEqual(await run({ url: "https://news.example/r/1" }), { status: "skipped", reason: "redirect to skip list: ft.com" })
    assert.ok(!web.calls.some((u) => u.includes("ft.com")))
  })

  it("skips a render that lands on a paywalled domain", async () => {
    const { run } = setup({}, { [SHELL_URL]: { url: "https://www.bloomberg.com/news/x", html: fixture("ledger-etf.html") } })
    assert.deepEqual(await run({ url: SHELL_URL, render: "always" }), { status: "skipped", reason: "redirect to skip list: bloomberg.com" })
  })

  it("skips a paywall teaser, even after rendering it", async () => {
    const url = "https://wire.example/premium/stocks-edge-higher"
    const { run, renders } = setup({ [url]: { body: fixture("teaser.html") } }, { [url]: { html: fixture("teaser.html") } })
    assert.deepEqual(await run({ url }), { status: "skipped", reason: "paywall teaser" })
    assert.equal(renders.length, 1)
  })

  it("skips a teaser that page furniture made long", async () => {
    const url = "https://wire.example/premium/long"
    const drawer = `<div class="notifications">${Array.from({ length: 60 }, (_, i) => `<p>News • ${i + 1} hours ago</p><p>Stocks moved on headline number ${i + 1} as traders weighed the latest earnings and rates news.</p>`).join("")}</div>`
    const { run } = setup({ [url]: { body: fixture("teaser.html").replace('<span class="badge">', `${drawer}<span class="badge">`) } })
    assert.deepEqual(await run({ url, render: "never" }), { status: "skipped", reason: "paywall teaser" })
  })

  it("fails a page whose 'article' is a link list or footer, even after rendering", async () => {
    const url = "https://club.example/members/4-things"
    const links = ["Subscribe to PRO", "Licensing & Reprints", "Councils", "Personal Finance", "Join the Panel", "Closed Captioning", "Digital Products", "News Releases", "Internships", "Corrections", "About Us", "Site Map", "Podcasts", "Careers", "Help", "Contact", "News Tips", "Advertise With Us", "Ad Choices", "Privacy Policy", "Terms of Service"]
    const html = `<html lang="en"><body><div class="page"><div class="links">${links.map((l) => `<p><a href="/x">${l}</a> and more about ${l.toLowerCase()}</p>`).join("")}</div><p>Got a confidential news tip? We want to hear from you.</p></div></body></html>`
    const { run, renders } = setup({ [url]: { body: html } }, { [url]: { html } })
    const r = await run({ url })
    assert.equal(r.status, "failed")
    assert.match(r.reason, /^no article text \(\d+% prose\)$/)
    assert.equal(renders.length, 1)
  })

  it("does not mistake a newsletter plug for a paywall", async () => {
    const { run } = setup({ [ETF_URL]: { body: fixture("ledger-etf.html").replace("</article>", "<p>Subscribe to our newsletter to read more stories like this.</p></article>") } })
    assert.equal((await run({ url: ETF_URL })).status, "ok")
  })

  it("refuses non-HTML responses and reports network errors", async () => {
    const { run } = setup({
      "https://files.example/report.pdf": { body: "%PDF-1.7", headers: { "content-type": "application/pdf" } },
      "https://down.example/a": Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }),
    })
    assert.deepEqual(await run({ url: "https://files.example/report.pdf" }), { status: "failed", reason: "not a web page: application/pdf" })
    assert.deepEqual(await run({ url: "https://down.example/a" }), { status: "failed", reason: "fetch failed: ENOTFOUND" })
  })

  it("caps the text at max_chars but counts every word", async () => {
    const { run } = setup({ [ETF_URL]: { body: fixture("ledger-etf.html") } })
    const r = await run({ url: ETF_URL, max_chars: 500 })
    assert.equal(r.status, "ok")
    assert.equal(r.truncated, true)
    assert.ok(r.text.length <= 500 && r.text.length > 400, `${r.text.length} chars`)
    assert.equal(r.words, 332)
  })

  it("decodes the charset the server declares", async () => {
    const latin1 = Buffer.from(`<html lang="fr"><body><article><p>${"Le café du marché a ouvert à huit heures ce matin. ".repeat(40)}</p></article></body></html>`, "latin1")
    const url = "https://presse.example/cafe"
    const { run } = setup({ [url]: () => new Response(latin1, { headers: { "content-type": "text/html; charset=ISO-8859-1" } }) })
    const r = await run({ url })
    assert.equal(r.status, "ok")
    assert.ok(r.text.startsWith("Le café du marché a ouvert à huit heures"))
    assert.equal(r.lang, "fr")
  })
})
