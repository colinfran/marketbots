import { DEFAULT_SETTINGS, settingsSchema } from "@mb/crypto-core/settings"
import { STRATEGIES, STRATEGY_IDS } from "@mb/crypto-core/strategies"
import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { WakeAgentForm } from "@mb/ui/agent"
import { StreamBadge } from "@mb/ui/live"
import { Badge } from "@mb/ui/components/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@mb/ui/components/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@mb/ui/components/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@mb/ui/components/tabs"
import { BannedAddresses } from "@mb/ui/bans"
import { SettingsForm } from "@mb/ui/settings-form"
import { Empty, PageHeader, SectionTitle, StatusBadge } from "@/components/bits"
import { CommandButton } from "@/components/command"
import { getViewer } from "@/lib/auth"
import { listBans } from "@/lib/bans"
import { getAudit, getCommands, getDatabaseStorage, getEngine, getEngineState, getNotifications, getRecentEvents, getSettings } from "@/lib/data"
import { ago, dateTime, titleCase, usd } from "@/lib/format"
import { SETTINGS_SECTIONS } from "./settings-sections"
import { SystemHealth } from "./system-health"

export const metadata: Metadata = { title: "Admin", robots: { index: false, follow: false } }

export default async function AdminPage() {
  const viewer = await getViewer()
  if (!viewer.owner) redirect("/login")
  const [doc, state, engine, audit, problems, notifications, commands, storage, bans] = await Promise.all([
    getSettings(),
    getEngineState(),
    getEngine(),
    getAudit(60),
    getRecentEvents(viewer, { limit: 40, levels: ["warn", "error"] }),
    getNotifications(20),
    getCommands(20),
    getDatabaseStorage(),
    listBans(),
  ])
  const parsed = settingsSchema.safeParse(doc?.settings)
  const settings = parsed.success ? parsed.data : DEFAULT_SETTINGS
  const ks = state?.kill_switch
  const running = state?.status === "running" && !ks?.engaged

  return (
    <div className="space-y-8">
      <PageHeader
        title="Admin"
        description="Owner controls and engine health. Every action goes straight to the engine, signed, is validated again there, and is written to the audit log."
        action={<StreamBadge />}
      />
      {!engine.online && <p className="text-loss text-sm">The engine is offline: commands cannot be sent until it is back.</p>}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              Trading {ks?.engaged ? <Badge variant="destructive">Kill switch</Badge> : <Badge variant="secondary">{titleCase(state?.status ?? "unknown")}</Badge>}
            </CardTitle>
            <CardDescription>
              {ks?.engaged
                ? `Halted ${dateTime(ks.at)} by ${ks.by}: ${ks.reason}`
                : state?.status === "paused"
                  ? `Paused${state.pause_reason ? `: ${state.pause_reason}` : ""}. No new decisions or entries; stops and targets stay active.`
                  : "Running: the agent decides and enters; stops and targets are active."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-3">
            {running ? (
              <CommandButton command={{ type: "pause", reason: "paused from the dashboard" }} label="Pause" />
            ) : !ks?.engaged ? (
              <CommandButton command={{ type: "resume" }} label="Resume" variant="default" />
            ) : null}
            <div className="w-full border-t pt-3">
              <p className="text-muted-foreground mb-2 text-xs">
                Wake the agent for a review now: of the pairs you name (up to 5), or of its book and the market. It looks things up and may act, inside its envelope and the
                risk checks; no trade is a normal answer.
              </p>
              <WakeAgentForm disabled={!running} placeholder={`e.g. ${settings.universe.kraken_symbols.slice(0, 2).join(", ")} (optional)`} />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Kill switch</CardTitle>
            <CardDescription>
              Immediately blocks every new order. Open positions stay protected by their stops and targets unless you also liquidate. Releasing it leaves the engine paused until you
              resume.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-3">
            {ks?.engaged ? (
              <CommandButton
                command={{ type: "kill_switch.release", confirm: "RELEASE" }}
                label="Release kill switch"
                confirm={{ title: "Release the kill switch?", description: "The engine stays paused afterwards; resume it separately.", phrase: "RELEASE", action: "Release" }}
              />
            ) : (
              <>
                <CommandButton
                  command={{ type: "kill_switch.engage", reason: "engaged from the dashboard", liquidate: false }}
                  label="Halt trading"
                  variant="destructive"
                  confirm={{ title: "Engage the kill switch?", description: "No new orders of any kind until you release it. Positions keep their stops.", action: "Halt" }}
                />
                <CommandButton
                  command={{ type: "kill_switch.engage", reason: "engaged with liquidation from the dashboard", liquidate: true }}
                  label="Halt & liquidate"
                  variant="destructive"
                  confirm={{ title: "Halt and sell everything?", description: "Engages the kill switch and sells every position at market in the paper wallet.", phrase: "LIQUIDATE", action: "Halt and sell" }}
                />
              </>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Paper wallet</CardTitle>
            <CardDescription>
              Reset closes the books and restarts the Kraken CLI paper wallet at {usd(settings.paper.starting_usd, { whole: true })} with a {settings.kraken.taker_fee_bps} bps fee and{" "}
              {settings.kraken.paper_slippage_bps} bps slippage. History is kept.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <CommandButton
              command={{ type: "paper.reset", confirm: "RESET" }}
              label="Reset paper wallet"
              confirm={{ title: "Reset the paper wallet?", description: "Open positions are written off and the wallet starts over at the starting capital.", phrase: "RESET", action: "Reset" }}
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Screens</CardTitle>
          <CardDescription>Code screens every pair as each minute&apos;s bars arrive; a setup from an enabled screen wakes the agent, which looks it up and decides. A disabled screen wakes it for nothing.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="divide-y">
            {STRATEGY_IDS.map((id) => {
              const cfg = settings.strategies[id]
              return (
                <li key={id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                  <span className="font-medium">{STRATEGIES[id].name}</span>
                  <Badge variant={cfg.enabled ? "secondary" : "outline"}>{cfg.enabled ? "Enabled" : "Disabled"}</Badge>
                  <span className="text-muted-foreground min-w-0 flex-1 text-xs">{STRATEGIES[id].summary}</span>
                  <span className="text-muted-foreground text-xs">max {cfg.max_exposure_pct}% of equity</span>
                  <CommandButton command={{ type: "strategy.set_enabled", strategy: id, enabled: !cfg.enabled }} label={cfg.enabled ? "Disable" : "Enable"} size="xs" />
                </li>
              )
            })}
          </ul>
        </CardContent>
      </Card>

      <Tabs defaultValue="system">
        <TabsList>
          <TabsTrigger value="system">System</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
        </TabsList>
        <TabsContent value="system" className="mt-4 space-y-8">
          <SystemHealth engine={engine} problems={problems} storage={storage} />
          <BannedAddresses bans={bans} dateTime={dateTime} />
        </TabsContent>
        {/* Kept mounted so unsaved edits survive switching tabs. */}
        <TabsContent value="settings" forceMount className="mt-4 data-[state=inactive]:hidden">
          <Card>
            <CardContent>{doc ? <SettingsForm sections={SETTINGS_SECTIONS} settings={settings} version={doc.version} /> : <Empty>Settings are created when the engine first starts.</Empty>}</CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="logs" className="mt-4 space-y-8">
          <div className="grid gap-6 lg:grid-cols-2">
            <section>
              <SectionTitle>Notifications</SectionTitle>
              {notifications.length === 0 ? (
                <Empty>None.</Empty>
              ) : (
                <ul className="space-y-2 text-sm">
                  {notifications.map((n) => (
                    <li key={n._id}>
                      <p className="flex items-center gap-2">
                        <StatusBadge status={n.level === "info" ? "done" : n.level === "warning" ? "rejected" : "failed"} label={titleCase(n.level)} />
                        <span className="font-medium">{n.title}</span>
                        <span className="text-muted-foreground text-xs">{ago(n.at)}</span>
                      </p>
                      <p className="text-muted-foreground mt-0.5 line-clamp-3 text-xs whitespace-pre-wrap">{n.message}</p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section>
              <SectionTitle>Commands</SectionTitle>
              {commands.length === 0 ? (
                <Empty>None sent yet.</Empty>
              ) : (
                <ul className="space-y-1.5 text-sm">
                  {commands.map((c) => (
                    <li key={c._id} className="flex items-center gap-2">
                      <StatusBadge status={c.status} />
                      <span className="font-mono text-xs">{c.type}</span>
                      <span className="text-muted-foreground line-clamp-1 text-xs">{c.error ?? c.result}</span>
                      <span className="text-muted-foreground ml-auto shrink-0 text-xs">{ago(c.created_at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
          <section>
            <SectionTitle>Audit log</SectionTitle>
            {audit.length === 0 ? (
              <Empty>Nothing yet.</Empty>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    <TableHead>Actor</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Details</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {audit.map((a) => (
                    <TableRow key={a._id}>
                      <TableCell className="text-muted-foreground text-xs whitespace-nowrap">{dateTime(a.at)}</TableCell>
                      <TableCell className="text-sm">{a.actor}</TableCell>
                      <TableCell className="font-mono text-xs">{a.action}</TableCell>
                      <TableCell className="text-muted-foreground max-w-xl truncate font-mono text-xs" title={JSON.stringify(a.details)}>
                        {JSON.stringify(a.details)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </section>
        </TabsContent>
      </Tabs>
    </div>
  )
}
