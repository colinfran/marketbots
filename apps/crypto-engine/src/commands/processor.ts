import { commandSchema, type Command } from "@mb/crypto-core/commands"
import { CommandProcessor as CommandProcessorOf, type CommandHandler as CommandHandlerOf } from "@mb/engine-kit/commands"
import type { Logger } from "@mb/engine-kit/log"
import type { EventBus } from "../bus/event-bus"
import type { Collections } from "../db/mongo"

/** The dashboard command processor (@mb/engine-kit/commands) for crypto's commands. */

export type CommandHandler = CommandHandlerOf<Command>

export class CommandProcessor extends CommandProcessorOf<Command> {
  constructor(col: Pick<Collections, "commands" | "audit">, bus: EventBus, log: Logger, handle: CommandHandler) {
    super(col, bus, log, handle, { schema: commandSchema })
  }
}
