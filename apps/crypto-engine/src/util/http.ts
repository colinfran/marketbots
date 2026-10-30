import { httpClient } from "@mb/engine-kit/util/http"

/** Sent unless the caller sets its own (some public APIs, the SEC's among them, require a descriptive one). */
export const DEFAULT_USER_AGENT = "CryptoMarketBot/0.1 (+https://github.com/colinfran/marketbots; hello@colinfran.com)"

/** fetch with a timeout and retries (@mb/engine-kit/util/http), sending crypto's User-Agent by default. */
export const { requestText, requestJson } = httpClient(DEFAULT_USER_AGENT)
