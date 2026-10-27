"use client"

import type { Command } from "@mb/stock-core/commands"
import { CommandButton as SharedCommandButton, useCommand as useSharedCommand } from "@mb/ui/command"

export { CommandResult } from "@mb/ui/command"

/** The shared command hook and button (@mb/ui/command), typed with this bot's commands. */
export const useCommand = () => useSharedCommand<Command>()

export const CommandButton = SharedCommandButton<Command>
