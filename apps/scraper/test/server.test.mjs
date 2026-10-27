import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:net"
import { after, before, describe, it } from "node:test"
import { fileURLToPath } from "node:url"

// Routing only: none of these requests reach the network or launch the browser.

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

describe("server", () => {
  let child
  let base

  before(async () => {
    const port = await freePort()
    base = `http://127.0.0.1:${port}`
    child = spawn(process.execPath, [fileURLToPath(new URL("../server.mjs", import.meta.url))], { env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "pipe", "inherit"] })
    await new Promise((resolve, reject) => {
      child.on("exit", (code) => reject(new Error(`server exited with ${code}`)))
      child.stdout.on("data", (chunk) => {
        if (String(chunk).includes("scraper listening")) resolve()
      })
    })
  })

  after(() => child?.kill())

  const post = (path, body) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-client": "crypto" }, body: typeof body === "string" ? body : JSON.stringify(body) })

  it("GET /health reports the extract counters", async () => {
    const res = await fetch(`${base}/health`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.active, 0)
    assert.equal(typeof body.extracts, "number")
  })

  it("POST /extract answers 200 with skipped for a paywalled domain", async () => {
    const res = await post("/extract", { url: "https://www.wsj.com/articles/x" })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { status: "skipped", reason: "skip list: wsj.com" })
    const health = await (await fetch(`${base}/health`)).json()
    assert.equal(health.extracts_skipped, 1)
  })

  it("POST /extract and /render reject bad requests with 400", async () => {
    const a = await post("/extract", "{")
    assert.equal(a.status, 400)
    assert.deepEqual(await a.json(), { error: "body is not JSON" })
    const b = await post("/render", { url: "ftp://a.example/" })
    assert.equal(b.status, 400)
    assert.deepEqual(await b.json(), { error: "only http and https URLs are rendered" })
  })

  it("unknown routes are 404", async () => {
    assert.equal((await fetch(`${base}/extract`)).status, 404)
    assert.equal((await post("/nope", {})).status, 404)
  })
})
