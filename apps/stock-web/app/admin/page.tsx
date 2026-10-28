import { formatDateTime } from "@mb/stock-core/time"
import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"
import { StreamBadge } from "@mb/ui/live"
import { Badge } from "@mb/ui/components/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@mb/ui/components/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@mb/ui/components/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@mb/ui/components/tabs"
import { SeedCard } from "@mb/ui/seed-card"
import { SettingsForm } from "@mb/ui/settings-form"
import { Empty, PageHeader, SectionTitle, StatusBadge } from "@/components/bits"
import { CommandButton } from "@/components/command"
import { getViewer } from "@/lib/auth"
import { ago, titleCase, usd, WEEKDAY_PLURAL } from "@/lib/format"
import { getAudit, getCommands, getEngine, getEngineState, getLiveAccount, getNotifications, getRecentEvents, getSeedRuns, getSettings, getSettingsDoc } from "@/lib/queries"
import { EvaluateForm } from "./evaluate-form"
import { SETTINGS_SECTIONS } from "./settings-sections"
import { SystemHealth } from "./system-health"

export const metadata: Metadata = { title: "Admin", robots: { index: false, follow: false } }

export default async function AdminPage() {
  const viewer = await getViewer()
  if (!viewer.owner) redirect("/login")
  const [doc, settings, state, engine, audit, problems, notifications, commands, live, seedRuns] = await Promise.all([
    getSettingsDoc(),
    getSettings(),
    getEngineState(),
    getEngine(),
    getAudit(60),
    getRecentEvents(viewer, { limit: 40, levels: ["warn", "error"] }),
    getNotifications(20),
    getCommands(20),
    getLiveAccount(),
    getSeedRuns(5),
  ])
  const ks = state?.kill_switch
  const running = state?.status === "running" && !ks?.engaged

  return (
    <div className="space-y-8">
      <PageHeader
        title="Admin"
        description="Owner controls and engine health. Every action is queued for the engine through MongoDB, validated again there, and written to the audit log."
        action={<StreamBadge />}
      />
      {!engine.online && <p className="text-loss text-sm">The engine is offline: commands will queue and run when it comes back (risk-increasing ones expire after 10 minutes).</p>}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              Trading {ks?.engaged ? <Badge variant="destructive">Kill switch</Badge> : <Badge variant="secondary">{titleCase(state?.status ?? "unknown")}</Badge>}
            </CardTitle>
            <CardDescription>
              {ks?.engaged
                ? `Halted ${formatDateTime(ks.at!)} by ${ks.by}: ${ks.reason}`
                : state?.status === "paused"
                  ? `Paused${state.pause_reason ? `: ${state.pause_reason}` : ""}. No new cycles or entries; stops, targets and options exits stay active.`
                  : "Running: scheduled cycles, AI decisions and entries are active."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-3">
            {running ? (
              <CommandButton command={{ type: "pause", reason: "paused from the dashboard" }} label="Pause" />
            ) : !ks?.engaged ? (
              <CommandButton command={{ type: "resume" }} label="Resume" variant="default" />
            ) : null}
            <CommandButton command={{ type: "broker.sync" }} label="Sync with Alpaca" />
            <div className="w-full border-t pt-3">
              <p className="text-muted-foreground mb-2 text-xs">
                Run a cycle now, optionally asking the AI to evaluate specific tickers (as stock or options ideas). It goes through the same research, decision and risk checks; doing nothing is a
                normal answer.
              </p>
              <EvaluateForm disabled={!running} />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Kill switch</CardTitle>
            <CardDescription>
              Immediately blocks every new order. Stocks stay protected by their broker-side stops and options by the engine&apos;s exits unless you also liquidate. Releasing it leaves the engine
              paused until you resume.
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
                  confirm={{ title: "Engage the kill switch?", description: "No new orders of any kind until you release it. Positions keep their exits.", action: "Halt" }}
                />
                <CommandButton
                  command={{ type: "kill_switch.engage", reason: "engaged with liquidation from the dashboard", liquidate: true }}
                  label="Halt & liquidate"
                  variant="destructive"
                  confirm={{ title: "Halt and sell everything?", description: "Engages the kill switch, closes every options position and sells every stock at market.", phrase: "LIQUIDATE", action: "Halt and sell" }}
                />
              </>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Paper account</CardTitle>
            <CardDescription>
              {live
                ? `Equity ${usd(live.equity)} · cash ${usd(live.cash)} · options level ${live.optionsLevel ?? "unknown"}${live.optionsLevel !== null && live.optionsLevel < 3 ? " (spreads need level 3)" : ""}.`
                : "No account snapshot yet."}{" "}
              To start over, reset the paper account to {usd(settings.account.starting_capital, { whole: true })} in the Alpaca dashboard (the API can&apos;t reset it).
            </CardDescription>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            Core book <Badge variant={settings.core.enabled ? "default" : "secondary"}>{settings.core.enabled ? "On" : "Off"}</Badge>
          </CardTitle>
          <CardDescription>
            Long-term holdings with written theses, about {settings.core.target_pct}% of equity, reviewed {WEEKDAY_PLURAL[settings.core.review_weekday]} at {settings.core.review_time_et} ET (turn it on and tune it under Settings → Core book). Running the
            review now counts as this week&apos;s and trades in the regular session. A dry run does the research and the decision and shows the trades it would make, without placing any; it works while the
            book is off and outside market hours. Each review costs about $0.50–0.80 of the AI budget. Results are on the{" "}
            <Link href="/core" className="text-foreground underline underline-offset-2">
              Core page
            </Link>
            .
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <CommandButton command={{ type: "core.review", dry_run: true }} label="Dry run (plan only)" />
          <CommandButton
            command={{ type: "core.review" }}
            label="Run core review now"
            variant="default"
            disabled={!settings.core.enabled || !running}
            confirm={{ title: "Run the core review now?", description: "Research, then a decision on every core holding and any new buys, placed at market within the core book's rules. It counts as this week's review.", action: "Run it" }}
          />
        </CardContent>
      </Card>

      <SeedCard
        runs={seedRuns}
        weekdaysOnly
        note="Puts about the amount into long-term core holdings, once. It runs in the regular session (after the opening buffer): research that morning decides what to buy, Grok picks 1-3 core holds, and the buys go through the normal risk checks (conviction, position size, cash reserve) as multi-day positions with broker-side stops. A failed run is never retried."
      />

      <Tabs defaultValue="system">
        <TabsList>
          <TabsTrigger value="system">System</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
        </TabsList>
        <TabsContent value="system" className="mt-4">
          <SystemHealth engine={engine} problems={problems} />
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
                      <TableCell className="text-muted-foreground text-xs whitespace-nowrap">{formatDateTime(a.at)}</TableCell>
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
