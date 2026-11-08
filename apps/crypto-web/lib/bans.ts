import "server-only"
import { createBans } from "@mb/web-kit/bans"
import { collections } from "./db"

/** The rate limit's permanent bans (@mb/web-kit/bans): the proxy's store, the Admin page's list and Unban. */
export const { store: banStore, listBans, unban } = createBans({
  bans: async () => (await collections()).webBans,
  audit: async () => (await collections()).audit,
})
