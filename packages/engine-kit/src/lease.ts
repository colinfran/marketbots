import type { LeaseDoc } from "@mb/core/db"
import type { Collection } from "mongodb"
import { errorMessage, type Logger } from "./log"
import { sleep } from "./util/async"

/**
 * Single-instance lease. Two engines trading the same books would double every order, so an
 * engine must hold this MongoDB lease to run. It's renewed every 10s and expires after 30s, so
 * after a crash a replacement can take over within half a minute. If a running engine ever finds
 * the lease held by someone else, it stops immediately.
 */

const TTL_MS = 30_000
const RENEW_MS = 10_000

export class Lease {
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly col: { lease: Collection<LeaseDoc> },
    private readonly holder: string,
    private readonly log: Logger,
  ) {}

  private async tryAcquire(): Promise<boolean> {
    const now = new Date()
    try {
      const doc = await this.col.lease.findOneAndUpdate(
        { _id: "engine", $or: [{ expires_at: { $lt: now } }, { holder: this.holder }] },
        { $set: { holder: this.holder, expires_at: new Date(now.getTime() + TTL_MS) }, $setOnInsert: { acquired_at: now } },
        { upsert: true, returnDocument: "after" },
      )
      return doc?.holder === this.holder
    } catch (error) {
      // Duplicate key on upsert: another live holder exists.
      if ((error as { code?: number }).code === 11000) return false
      throw error
    }
  }

  /** Waits until the lease is ours. */
  async acquire(signal?: AbortSignal) {
    for (let attempt = 0; !signal?.aborted; attempt++) {
      if (await this.tryAcquire()) {
        this.log.info("engine lease acquired", { holder: this.holder })
        return
      }
      if (attempt === 0) this.log.warn("another engine holds the lease; waiting for it to expire")
      await sleep(5_000, signal)
    }
  }

  /** Renews in the background; `onLost` runs if another holder took over. */
  keepAlive(onLost: () => void) {
    this.timer = setInterval(async () => {
      try {
        if (!(await this.tryAcquire())) {
          this.log.error("engine lease lost to another instance; stopping")
          onLost()
        }
      } catch (error) {
        // A transient database error isn't a lost lease; the next renewal retries.
        this.log.warn("lease renewal failed", { error: errorMessage(error) })
      }
    }, RENEW_MS)
  }

  async release() {
    if (this.timer) clearInterval(this.timer)
    await this.col.lease.deleteOne({ _id: "engine", holder: this.holder }).catch(() => undefined)
  }
}
