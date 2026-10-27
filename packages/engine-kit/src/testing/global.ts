import { MongoMemoryServer } from "mongodb-memory-server"
import type { TestProject } from "vitest/node"

declare module "vitest" {
  export interface ProvidedContext {
    mongoUri: string
  }
}

/**
 * Vitest global setup for an engine's tests: starts one throwaway mongod for the whole run.
 * Each package's `test/setup/global.ts` re-exports it (the `engineTest` preset points there).
 */
export default async function setup(project: TestProject) {
  const server = await MongoMemoryServer.create({
    // Tests pin the clock to fixed dates; a live TTL monitor would delete "expired" locks,
    // alerts and cache entries mid-test.
    instance: { args: ["--setParameter", "ttlMonitorEnabled=false"] },
  })
  project.provide("mongoUri", server.getUri())
  return async () => {
    await server.stop()
  }
}
