import { main as closeoutContext } from "./modules/workspace/closeout_context_cli";
import { main as closeoutGate } from "./modules/workspace/closeout_gate_cli";
import { main as localCloseoutContext } from "./modules/workspace/local_merge_closeout_context_cli";
import { main as localCloseoutGate } from "./modules/workspace/local_merge_closeout_gate_cli";
import { main as mergePreflight } from "./modules/workspace/merge_preflight";
import { main as portRegistry } from "./modules/workspace/port_registry_cli";
import { main as candidateContext } from "./modules/workspace/candidate_context";

const commands = {
  closeout_context: closeoutContext,
  closeout_gate: closeoutGate,
  local_merge_closeout_context: localCloseoutContext,
  local_merge_closeout_gate: localCloseoutGate,
  merge_preflight: mergePreflight,
  port_registry: portRegistry,
  candidate_context: candidateContext,
} as const;

export function workspace(
  name: keyof typeof commands,
  argv: string[],
): Promise<number> {
  return commands[name](argv);
}
