"use client"

import { LogInIcon, LogOutIcon, MenuIcon, MoonIcon, SunIcon } from "lucide-react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { useTheme } from "next-themes"
import { Fragment } from "react"
import { cn } from "cn"
import { Button } from "./components/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "./components/dropdown-menu"
import { useKit } from "./kit"
import { authClient } from "./lib/auth-client"
import { StatusPill } from "./live"

/** A page in the navigation. `also`: detail pages that belong to it (they light it up too). */
export type NavPage = { href: string; label: string; also?: string[] }

type Section = { label: string; pages: NavPage[] }

/**
 * Both dashboards have the same pages under the same URLs, in five sections. The header links to
 * each section's first page; a section with more than one page lists them in a second row.
 */
const SECTIONS: Section[] = [
  { label: "Live", pages: [{ href: "/", label: "Live" }] },
  {
    label: "Portfolio",
    pages: [
      { href: "/holdings", label: "Holdings" },
      { href: "/trades", label: "Trades" },
    ],
  },
  {
    label: "Research",
    pages: [
      { href: "/research", label: "AI research", also: ["/decisions"] },
      { href: "/news", label: "News" },
      { href: "/markets", label: "Markets" },
    ],
  },
  {
    label: "Performance",
    pages: [
      { href: "/analytics", label: "Analytics" },
      { href: "/strategies", label: "Strategies" },
      { href: "/journal", label: "Journal" },
    ],
  },
  { label: "About", pages: [{ href: "/about", label: "About" }] },
]

const ADMIN: Section = { label: "Admin", pages: [{ href: "/admin", label: "Admin" }] }

const under = (pathname: string, href: string) => (href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`))
const isActive = (pathname: string, page: NavPage) => [page.href, ...(page.also ?? [])].some((href) => under(pathname, href))

/** `extra`: pages only this dashboard has, by section label, added at the end of that section. */
export function SiteHeader({
  owner,
  engine,
  extra = {},
}: {
  owner: boolean
  engine: { online: boolean; status: string | null; cycleState: string | null }
  extra?: Record<string, NavPage[]>
}) {
  const { name, Mark } = useKit()
  const pathname = usePathname()
  const router = useRouter()
  const { resolvedTheme, setTheme } = useTheme()
  const sections = [...SECTIONS.map((s) => ({ ...s, pages: [...s.pages, ...(extra[s.label] ?? [])] })), ...(owner ? [ADMIN] : [])]
  const current = sections.find((s) => s.pages.some((p) => isActive(pathname, p))) ?? null
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
        <nav className="-mx-1 hidden flex-1 items-center gap-0.5 lg:flex" aria-label="Main">
          {sections.map((s) => (
            <Link
              key={s.label}
              href={s.pages[0].href}
              aria-current={s === current ? "page" : undefined}
              className={cn(
                "rounded-md px-2.5 py-1.5 text-sm whitespace-nowrap transition-colors",
                s === current ? "bg-muted text-foreground font-medium" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {s.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-1">
          <StatusPill initial={engine} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild className="lg:hidden">
              <Button variant="ghost" size="icon" aria-label="Menu">
                <MenuIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              {sections.map((s, i) => (
                <Fragment key={s.label}>
                  {i > 0 && <DropdownMenuSeparator />}
                  {s.pages.length > 1 && <DropdownMenuLabel className="text-muted-foreground text-xs">{s.label}</DropdownMenuLabel>}
                  {s.pages.map((p) => (
                    <DropdownMenuItem key={p.href} asChild>
                      <Link href={p.href}>{p.label}</Link>
                    </DropdownMenuItem>
                  ))}
                </Fragment>
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
      {current && current.pages.length > 1 && (
        <nav className="mx-auto flex w-full max-w-7xl items-center gap-0.5 overflow-x-auto px-4 pb-2" aria-label={current.label}>
          {current.pages.map((p) => {
            const active = isActive(pathname, p)
            return (
              <Link
                key={p.href}
                href={p.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "rounded-md px-2.5 py-1 text-sm whitespace-nowrap transition-colors",
                  active ? "text-foreground font-medium underline decoration-2 underline-offset-8" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {p.label}
              </Link>
            )
          })}
        </nav>
      )}
    </header>
  )
}
