import "server-only"
import { watchDatabaseStorage } from "@mb/web-kit/storage"
import { sendAlert } from "./alerts"
import { mongoClient } from "./db"

/** The databases' 32 GB budget, checked hourly; a Discord alert at 80% and 90% (@mb/web-kit/storage, docs/SERVER.md §6.6). */
export const startStorageWatch = () => watchDatabaseStorage({ client: mongoClient, sendAlert })
