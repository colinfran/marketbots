import { APPLE_ICON_SIZE } from "@mb/web-kit/og"
import { appleIcon } from "@/lib/og"

export const size = APPLE_ICON_SIZE
export const contentType = "image/png"

export default function AppleIcon() {
  return appleIcon()
}
