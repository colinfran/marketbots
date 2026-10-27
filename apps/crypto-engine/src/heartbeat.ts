import { cpus, loadavg } from "node:os"

/**
 * Process resource usage for the Admin page: CPU % (of all cores) since the previous sample,
 * memory and load average.
 */
export class ResourceSampler {
  private last = { at: process.hrtime.bigint(), cpu: process.cpuUsage() }

  sample() {
    const now = process.hrtime.bigint()
    const cpu = process.cpuUsage()
    const elapsedUs = Number(now - this.last.at) / 1_000
    const usedUs = cpu.user - this.last.cpu.user + (cpu.system - this.last.cpu.system)
    this.last = { at: now, cpu }
    const mem = process.memoryUsage()
    return {
      cpu_pct: elapsedUs > 0 ? Math.round((usedUs / elapsedUs / Math.max(1, cpus().length)) * 1000) / 10 : 0,
      rss_mb: Math.round(mem.rss / 1_048_576),
      heap_mb: Math.round(mem.heapUsed / 1_048_576),
      load_avg: loadavg().map((l) => Math.round(l * 100) / 100),
      uptime_s: Math.round(process.uptime()),
    }
  }
}
