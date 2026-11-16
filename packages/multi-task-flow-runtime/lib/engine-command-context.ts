import type { Ledger, Plan } from "../lib/schema";
import type { Request } from "./engine-support-core";

export type CommandContext = {
  ledger: Ledger;
  command: string;
  request: Request;
  payload: Record<string, unknown>;
  currentPlan: () => Plan;
};

export type CommandHandler = (context: CommandContext) => unknown | undefined;

export type CommandDomain = {
  commands: readonly string[];
  handle: CommandHandler;
};

export function indexCommandDomains(
  domains: readonly CommandDomain[],
): ReadonlyMap<string, CommandHandler> {
  const handlers = new Map<string, CommandHandler>();
  for (const domain of domains) {
    for (const command of domain.commands) {
      if (handlers.has(command))
        throw new Error(`Command assigned to multiple domains: ${command}`);
      handlers.set(command, domain.handle);
    }
  }
  return handlers;
}
