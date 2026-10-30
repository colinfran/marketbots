import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { DEFAULT_HOST_SETTINGS, hostSettingsSchema, type HostSettings } from "@mb/core/host"

/**
 * The agent's settings (@mb/core/host hostSettingsSchema), kept in a JSON file on the server: the
 * one place they live, whichever dashboard changed them. No secrets.
 */
export class SettingsFile {
  value: HostSettings = { ...DEFAULT_HOST_SETTINGS }

  constructor(private readonly file: string) {}

  async load(): Promise<HostSettings> {
    let text: string
    try {
      text = await readFile(this.file, "utf8")
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return this.value
      throw e
    }
    const parsed = hostSettingsSchema.safeParse(JSON.parse(text))
    if (!parsed.success) throw new Error(`Invalid settings in ${this.file}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`)
    return (this.value = parsed.data)
  }

  async save(next: HostSettings): Promise<HostSettings> {
    const value = hostSettingsSchema.parse(next)
    await mkdir(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    await rename(tmp, this.file)
    return (this.value = value)
  }
}
