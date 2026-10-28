import { useSyncExternalStore } from "react"

const installedApp = () => matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true
const noSubscribe = () => () => undefined

/** Whether the dashboard runs as an installed Home Screen app rather than in a browser tab. False on the server. */
export const useInstalledApp = () => useSyncExternalStore(noSubscribe, installedApp, () => false)
