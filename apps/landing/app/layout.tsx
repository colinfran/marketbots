import type { Metadata, Viewport } from "next"
import { Geist, Geist_Mono } from "next/font/google"
import { jsonLd, site } from "@/lib/site"
import { FranceschiniAnalytics } from "@colinfran/analytics"
import "./globals.css"

const geistSans = Geist({ variable: "--font-sans", subsets: ["latin"] })
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] })

export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  title: site.title,
  description: site.description,
  applicationName: site.name,
  keywords: [...site.keywords],
  authors: [{ name: site.author.name, url: site.author.url }],
  creator: site.author.name,
  publisher: site.author.name,
  category: "finance",
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: "/",
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
  robots: { index: true, follow: true },
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
  ],
}

/**
 * The document only. The site's chrome (theme, header, footer) is in app/(site)/layout.tsx, so
 * app/embed/ can serve parts of the page bare, for other sites to frame.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-dvh flex-col">
        <script type="application/ld+json" dangerouslySetInnerHTML={jsonLd(structuredData)} />
        {children}
        <FranceschiniAnalytics websiteId="web_qZcLqyl9x1O4e4Kj6cqF"/>
      </body>
    </html>
  )
}
