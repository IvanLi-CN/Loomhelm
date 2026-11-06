import { createTerminalState } from "./pr_terminal_state";
import { scanTerminal } from "./pr_terminal_scan";
import type { Finding } from "./replay";

export function analyzePrTerminal(path: string): Finding[] {
  const state = createTerminalState();
  scanTerminal(state, path);
  return state.findings;
}
