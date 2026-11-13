import type { WebBanDoc } from "@mb/core/db"
import { Empty } from "./bits"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./components/table"
import { ago, num } from "./lib/format"
import { UnbanButton } from "./unban-button"

/**
 * Admin page: the addresses the dashboard's rate limit banned for good, for flooding or for a
 * scanner's probe (docs/SERVER.md §8.6), with
 * what earned each ban, how many requests it has been refused since, and an Unban button.
 */
export function BannedAddresses({ bans, dateTime }: { bans: WebBanDoc[]; dateTime: (value: Date) => string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Banned addresses</CardTitle>
        <CardDescription>
          Addresses that kept requesting after the rate limit refused them, and scanners on their first probe (a path like /.env or /wp-admin; hover the date for the reason),
          are banned for good: every request from them gets 403. Unban lets one back in within a minute.
          Signing in from a banned address lifts its ban too. This site only: Caddy&apos;s ban list (C:\Caddy\marketbots-banned.caddy) blocks an address on both.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {bans.length === 0 ? (
          <Empty>Nobody is banned.</Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Address</TableHead>
                <TableHead>Banned</TableHead>
                <TableHead className="text-right">Refused since</TableHead>
                <TableHead>Request that earned it</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {bans.map((b) => (
                <TableRow key={b._id}>
                  <TableCell className="font-mono text-xs">{b._id}</TableCell>
                  <TableCell className="text-xs whitespace-nowrap" title={b.reason}>
                    {dateTime(b.banned_at)}
                    <span className="text-muted-foreground block">{ago(b.banned_at)}</span>
                  </TableCell>
                  <TableCell className="text-right text-xs whitespace-nowrap">
                    {num(b.blocked, 0)}
                    {b.last_seen_at && <span className="text-muted-foreground block">last {ago(b.last_seen_at)}</span>}
                  </TableCell>
                  <TableCell className="max-w-md text-xs">
                    <span className="block truncate font-mono" title={b.path ?? undefined}>
                      {b.path ?? "–"}
                    </span>
                    <span className="text-muted-foreground block truncate" title={b.user_agent ?? undefined}>
                      {b.user_agent ?? "no user agent"}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    <UnbanButton address={b._id} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
