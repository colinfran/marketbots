import type { Metadata, Viewport } from "next"
import { Geist, Geist_Mono } from "next/font/google"
import { FranceschiniAnalytics } from "@colinfran/analytics"
import { SiteHeader } from "@mb/ui/site-header"
import { Providers } from "@/components/providers"
import { getViewer } from "@/lib/auth"
import { getEngine, getRecentEvents } from "@/lib/queries"
import { jsonLd, site } from "@/lib/site"
import "./globals.css"

const geistSans = Geist({ variable: "--font-sans", subsets: ["latin"] })
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] })

export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  title: { default: site.title, template: `%s · ${site.name}` },
  description: site.description,
  applicationName: site.name,
  keywords: [...site.keywords],
  authors: [{ name: site.author.name, url: site.author.url }],
  creator: site.author.name,
  publisher: site.author.name,
  category: "finance",
  openGraph: {
    type: "website",
    siteName: site.name,
    title: site.title,
    description: site.tagline,
    locale: "en_US",
    images: [site.ogImage],
  },
  twitter: {
    card: "summary_large_image",
    title: site.title,
    description: site.tagline,
    images: [site.ogImage],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1, "max-video-preview": -1 },
  },
  formatDetection: { telephone: false },
}

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
}

const structuredData = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Person",
      "@id": `${site.author.url}/#person`,
      name: site.author.name,
      url: site.author.url,
    },
    {
      "@type": "WebSite",
      "@id": `${site.url}/#website`,
      url: site.url,
      name: site.name,
      description: site.description,
      inLanguage: "en-US",
      author: { "@id": `${site.author.url}/#person` },
      creator: { "@id": `${site.author.url}/#person` },
      publisher: { "@id": `${site.author.url}/#person` },
    },
    {
      "@type": "WebApplication",
      "@id": `${site.url}/#app`,
      name: site.name,
      url: site.url,
      description: site.description,
      applicationCategory: "FinanceApplication",
      operatingSystem: "Web",
      isAccessibleForFree: true,
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      author: { "@id": `${site.author.url}/#person` },
    },
  ],
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const viewer = await getViewer()
  // The shell still renders if MongoDB is unreachable; pages show their own errors.
  const [engine, events] = await Promise.all([
    getEngine().catch(() => ({ status: null, online: false, heartbeatAgeS: null })),
    getRecentEvents(viewer, { limit: 300 }).catch(() => []),
  ])
  return (
    <html lang="en" suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <script type="application/ld+json" dangerouslySetInnerHTML={jsonLd(structuredData)} />
        <Providers initialEvents={events}>
          <SiteHeader owner={viewer.owner} engine={{ online: engine.online, status: engine.status?.status ?? null, cycleState: engine.status?.cycle_state ?? null }} extra={[{ href: "/core", label: "Core" }]} />
          <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:py-8">{children}</main>
          <footer className="text-muted-foreground mx-auto flex w-full max-w-7xl flex-col gap-1 px-4 pb-8 text-xs sm:flex-row sm:justify-between sm:gap-6">
            <p>Paper trading with fake money (an Alpaca paper account) for research and entertainment. Not financial advice; options can lose their entire value.</p>
            <p className="shrink-0">
              Built by{" "}
              <a href={site.author.url} rel="author" className="hover:text-foreground underline underline-offset-2">
                {site.author.name}
              </a>
            </p>
          </footer>
        </Providers>
        <FranceschiniAnalytics websiteId="web_2PNy7F5c7q3n3ziabLBR" />
      </body>
    </html>
  )
}
