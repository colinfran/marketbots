import { MongoMemoryServer } from "mongodb-memory-server"
import type { TestProject } from "vitest/node"

declare module "vitest" {
  export interface ProvidedContext {
    mongoUri: string
  }
}

/** Starts one throwaway mongod for the whole test run. */
export default async function setup(project: TestProject) {
  const server = await MongoMemoryServer.create({
    // Tests pin clocks to fixed dates; a live TTL monitor would delete "expired" documents mid-test.
    instance: { args: ["--setParameter", "ttlMonitorEnabled=false"] },
  })
  project.provide("mongoUri", server.getUri())
  return async () => {
    await server.stop()
  }
}
