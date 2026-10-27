"use client"

import { LogInIcon, LogOutIcon, MenuIcon, MoonIcon, SunIcon } from "lucide-react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { useTheme } from "next-themes"
import { cn } from "cn"
import { Button } from "./components/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./components/dropdown-menu"
import { useKit } from "./kit"
import { authClient } from "./lib/auth-client"
import { StatusPill } from "./live"

/** Both dashboards have the same pages under the same URLs. The bot's name and mark come from its kit. */
const NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/live", label: "Live" },
  { href: "/holdings", label: "Holdings" },
  { href: "/trades", label: "Trades" },
  { href: "/markets", label: "Markets" },
  { href: "/research", label: "Research" },
  { href: "/strategies", label: "Strategies" },
  { href: "/journal", label: "Journal" },
  { href: "/analytics", label: "Analytics" },
  { href: "/about", label: "About" },
]

export function SiteHeader({ owner, engine }: { owner: boolean; engine: { online: boolean; status: string | null; cycleState: string | null } }) {
  const { name, Mark } = useKit()
  const pathname = usePathname()
  const router = useRouter()
  const { resolvedTheme, setTheme } = useTheme()
  const nav = owner ? [...NAV, { href: "/admin", label: "Admin" }] : NAV
  const active = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href))
  const logout = async () => {
    await authClient.signOut()
    router.refresh()
  }
  return (
    <header className="bg-background/85 sticky top-0 z-40 border-b backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-7xl items-center gap-3 px-4">
        <Link href="/" className="flex shrink-0 items-center gap-2 font-semibold">
          <Mark className="size-5" />
          <span className="hidden sm:inline">{name}</span>
        </Link>
        <nav className="-mx-1 hidden flex-1 items-center gap-0.5 overflow-x-auto xl:flex" aria-label="Main">
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "rounded-md px-2.5 py-1.5 text-sm whitespace-nowrap transition-colors",
                active(item.href) ? "bg-muted text-foreground font-medium" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-1">
          <StatusPill initial={engine} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild className="xl:hidden">
              <Button variant="ghost" size="icon" aria-label="Menu">
                <MenuIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {nav.map((item) => (
                <DropdownMenuItem key={item.href} asChild>
                  <Link href={item.href}>{item.label}</Link>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="ghost" size="icon" aria-label="Toggle theme" onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}>
            <SunIcon className="hidden dark:block" />
            <MoonIcon className="dark:hidden" />
          </Button>
          {owner ? (
            <Button variant="ghost" size="icon" aria-label="Sign out" title="Sign out" onClick={() => void logout()}>
              <LogOutIcon />
            </Button>
          ) : (
            <Button variant="ghost" size="icon" aria-label="Owner sign in" title="Owner sign in" asChild>
              <Link href="/login">
                <LogInIcon />
              </Link>
            </Button>
          )}
        </div>
      </div>
    </header>
  )
}
