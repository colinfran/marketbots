// Sets up the stack's MongoDB (compose.yml `mongo`; docs/SERVER.md §6.6): the replica set, the
// root user, a role per dashboard and a user per bot and job. Idempotent: run it after creating the
// volume and again whenever a MONGO_* password in .env changes (then recreate what uses it):
//
//   docker compose exec mongo mongosh --quiet /etc/mongo/init.js
//
// On a new volume it uses the localhost exception (no user yet, a connection from inside the
// container) to initiate the replica set and create root; after that it signs in as root. The
// passwords come from the container's environment (compose passes the MONGO section of .env) and are
// never printed.

const need = (name) => {
  const value = process.env[name]
  if (!value || !/^[0-9a-f]{32,}$/i.test(value)) throw new Error(`${name} is missing or not hex (32+ characters): fill in .env's MONGO section, then recreate mongo`)
  return value
}

const CRYPTO_DB = process.env.CRYPTO_DB || "cryptomarketbot"
const STOCK_DB = process.env.STOCK_DB || "stockmarketbot"
const MEMBER = "mongo:27017"

const admin = db.getSiblingDB("admin")

// 1. Signed in as root, unless this is a new volume (no users: the localhost exception applies).
let signedIn = false
try {
  signedIn = admin.auth("root", need("MONGO_ROOT_PASSWORD")).ok === 1
} catch (e) {
  if (/missing or not hex/.test(String(e.message))) throw e
}

// 2. The replica set: one member, under its compose service name (every client connects with
// replicaSet=rs0 and finds it there).
if (!db.hello().setName) {
  rs.initiate({ _id: "rs0", members: [{ _id: 0, host: MEMBER }] })
  print("replica set rs0 initiated")
}
for (let i = 0; !db.hello().isWritablePrimary; i++) {
  if (i >= 60) throw new Error("no primary after 60 s")
  sleep(1000)
}

// 3. root, the first user (closes the localhost exception).
if (!signedIn) {
  admin.createUser({ user: "root", pwd: need("MONGO_ROOT_PASSWORD"), roles: ["root"] })
  admin.auth("root", need("MONGO_ROOT_PASSWORD"))
  print("created root")
}

// 4. A dashboard reads its own bot's database and writes only what it writes (from a grep of every
// dashboard write): audit entries, the login rate limits, the rate limit's bans and Better Auth's sign-in records. Admin →
// System's storage card lists the databases and their sizes, both bots' (dbStats only, no data).
const dashboardPrivileges = (dbName) => [
  { resource: { db: dbName, collection: "" }, actions: ["find", "listCollections", "listIndexes", "collStats", "dbStats"] },
  { resource: { db: dbName, collection: "audit_log" }, actions: ["insert"] },
  { resource: { db: dbName, collection: "login_attempts" }, actions: ["find", "insert", "update"] },
  // The rate limit's permanent bans (docs/SERVER.md §8.6): added by the proxy, lifted on the Admin page.
  { resource: { db: dbName, collection: "web_bans" }, actions: ["find", "insert", "update", "remove"] },
  ...["auth_users", "auth_sessions", "auth_accounts", "auth_verifications"].map((collection) => ({
    resource: { db: dbName, collection },
    actions: ["find", "insert", "update", "remove"],
  })),
  { resource: { cluster: true }, actions: ["listDatabases"] },
  { resource: { db: "", collection: "" }, actions: ["dbStats"] },
]

const upsertRole = (role, privileges) => {
  if (admin.getRole(role)) admin.updateRole(role, { privileges, roles: [] })
  else admin.createRole({ role, privileges, roles: [] })
  print(`role ${role}: ok`)
}

const upsertUser = (user, pwd, roles) => {
  if (admin.getUser(user)) admin.updateUser(user, { pwd, roles })
  else admin.createUser({ user, pwd, roles })
  print(`user ${user}: ok (${roles.map((r) => (typeof r === "string" ? r : `${r.role}@${r.db}`)).join(", ")})`)
}

upsertRole("crypto_dashboard", dashboardPrivileges(CRYPTO_DB))
upsertRole("stock_dashboard", dashboardPrivileges(STOCK_DB))

// 5. Each engine owns its own database and can't see the other's; each dashboard has its role; the
// backup job reads everything (mongo-backup).
upsertUser("root", need("MONGO_ROOT_PASSWORD"), ["root"])
upsertUser("crypto_engine", need("MONGO_CRYPTO_ENGINE_PASSWORD"), [{ role: "readWrite", db: CRYPTO_DB }])
upsertUser("stock_engine", need("MONGO_STOCK_ENGINE_PASSWORD"), [{ role: "readWrite", db: STOCK_DB }])
upsertUser("crypto_web", need("MONGO_CRYPTO_WEB_PASSWORD"), [{ role: "crypto_dashboard", db: "admin" }])
upsertUser("stock_web", need("MONGO_STOCK_WEB_PASSWORD"), [{ role: "stock_dashboard", db: "admin" }])
upsertUser("backup", need("MONGO_BACKUP_PASSWORD"), ["backup"])

print("done")
