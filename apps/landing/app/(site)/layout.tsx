import { MarketbotsMark } from "@/components/marks"
import { Providers, ThemeToggle } from "@/components/theme"
import { site } from "@/lib/site"

/** The site's chrome: the viewer's theme, the header and the footer. */
export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <Providers>
      <header className="mx-auto flex h-14 w-full max-w-5xl items-center gap-2 px-4">
        <MarketbotsMark className="size-5" />
        <span className="font-semibold">{site.name}</span>
        <div className="ml-auto">
          <ThemeToggle />
        </div>
      </header>
      {/* One screen: the content sits in the middle of whatever height is left. */}
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col justify-center px-4">{children}</main>
      <footer className="text-muted-foreground mx-auto flex w-full max-w-5xl flex-col gap-1 border-t px-4 py-4 text-xs sm:flex-row sm:justify-between sm:gap-6">
        <p>Simulated money at live prices; no real money is at risk. Not financial advice.</p>
        <p className="shrink-0">
          Built by{" "}
          <a href={site.author.url} rel="author" className="hover:text-foreground underline underline-offset-2">
            {site.author.name}
          </a>
        </p>
      </footer>
    </Providers>
  )
}
