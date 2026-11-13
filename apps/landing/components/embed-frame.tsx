"use client"

import { useEffect, useRef } from "react"

/**
 * The page side of an embed, for the site framing it (colinfran.com's blog):
 *
 * - it posts `{ type: "marketbots:height", height }` to the framing page whenever its content's
 *   height changes, and in answer to any message from it, so the frame can fit the content;
 * - it takes `{ type: "marketbots:theme", theme: "dark" | "light" }` from the framing page, so the
 *   embed follows that page's theme toggle. Before the first message the `?theme=` in its URL
 *   decides (THEME_SCRIPT, before paint), else the system theme.
 *
 * The embed never stores a theme: the viewer's choice on this site stays theirs.
 */
export function EmbedFrame({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const post = () => window.parent.postMessage({ type: "marketbots:height", height: Math.ceil(el.getBoundingClientRect().height) }, "*")
    const resize = new ResizeObserver(post)
    resize.observe(el)
    const onMessage = (e: MessageEvent) => {
      if (e.source !== window.parent || window.parent === window) return
      if (e.data?.type === "marketbots:theme" && (e.data.theme === "dark" || e.data.theme === "light")) setTheme(e.data.theme === "dark")
      post()
    }
    window.addEventListener("message", onMessage)
    return () => {
      resize.disconnect()
      window.removeEventListener("message", onMessage)
    }
  }, [])

  return <div ref={ref}>{children}</div>
}

function setTheme(dark: boolean) {
  document.documentElement.classList.toggle("dark", dark)
  document.documentElement.style.colorScheme = dark ? "dark" : "light"
}

/**
 * Sets the theme before the embed paints: `?theme=dark|light`, else the system's. The color scheme
 * matches too, so the frame stays transparent over the framing page.
 */
export const THEME_SCRIPT = `(() => {
  const t = new URLSearchParams(location.search).get("theme");
  const dark = t === "dark" || (t !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
})()`
