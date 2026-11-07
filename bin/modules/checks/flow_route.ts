function parseShellTokens(command: string): string[] | undefined {
  if (/[;&|<>`$()\r\n*?\[\]{}~]/.test(command)) return undefined;
  const tokens: string[] = [];
  let token = "";
  let started = false;
  let quote: "'" | '"' | undefined;
  let escaped = false;
  const push = () => {
    if (started) tokens.push(token);
    token = "";
    started = false;
  };
  for (const character of command) {
    if (escaped) {
      token += character;
      started = true;
      escaped = false;
    } else if (quote) {
      if (character === quote) quote = undefined;
      else token += character;
      started = true;
    } else if (character === "\\") {
      escaped = true;
      started = true;
    } else if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (/\s/.test(character)) {
      push();
    } else {
      token += character;
      started = true;
    }
  }
  if (quote || escaped) return undefined;
  push();
  return tokens.length ? tokens : undefined;
}

function normalizeRepositoryPath(path: string): string {
  let normalized = path.replaceAll("\\", "/");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  return normalized;
}

function isPythonInterpreter(token: string): boolean {
  return /(?:^|\/)python3(?:\.\d+)?$/.test(token);
}

function isBunInterpreter(token: string): boolean {
  return /(?:^|\/)bun$/.test(token);
}

function isFlowReceiptScript(token: string): boolean {
  const normalized = normalizeRepositoryPath(token);
  return (
    normalized === "bin/flow_receipt.ts" ||
    normalized === "bin/flow_receipt.py" ||
    /\/bin\/flow_receipt\.(?:ts|py)$/.test(normalized)
  );
}

export function flowReceiptCommandTail(command: string): string[] | undefined {
  const tokens = parseShellTokens(command);
  if (!tokens) return undefined;
  let scriptIndex: number | undefined;
  if (isFlowReceiptScript(tokens[0]!)) scriptIndex = 0;
  else if (
    tokens.length >= 2 &&
    (isPythonInterpreter(tokens[0]!) || isBunInterpreter(tokens[0]!)) &&
    isFlowReceiptScript(tokens[1]!)
  )
    scriptIndex = 1;
  else if (
    tokens.length >= 3 &&
    isBunInterpreter(tokens[0]!) &&
    tokens[1] === "run" &&
    isFlowReceiptScript(tokens[2]!)
  )
    scriptIndex = 2;
  if (scriptIndex === undefined) return undefined;
  let tail = tokens.slice(scriptIndex + 1);
  if (tail[0] === "--repo" || tail[0]?.startsWith("--repo=")) {
    if (tail[0] === "--repo") {
      if (!tail[1] || tail[1]!.startsWith("-")) return undefined;
      tail = tail.slice(2);
    } else {
      const repoPath = tail[0]!.slice("--repo=".length);
      if (!repoPath || repoPath.startsWith("-")) return undefined;
      tail = tail.slice(1);
    }
  }
  return tail;
}

export function repairWaveCommand(tail: string[] | undefined): boolean {
  if (!tail || tail.slice(0, 2).join(" ") !== "review-wave open") return false;
  const allowed = new Set([
    "--stage",
    "--base-ref",
    "--head-sha",
    "--scope-class",
    "--lane",
    "--previous-head-sha",
    "--repair-permit-id",
  ]);
  const seen = new Set<string>();
  const values = new Map<string, string>();
  let lanes = 0;
  for (let index = 2; index < tail.length; index += 1) {
    const token = tail[index]!;
    if (token === "--" || !token.startsWith("--")) return false;
    let option = token;
    let value: string | undefined;
    const separator = token.indexOf("=");
    if (separator >= 0) {
      option = token.slice(0, separator);
      value = token.slice(separator + 1);
    } else {
      value = tail[index + 1];
      index += 1;
      if (!value || value.startsWith("--")) return false;
    }
    if (!allowed.has(option) || !value) return false;
    if (option === "--lane") lanes += 1;
    else {
      if (seen.has(option)) return false;
      seen.add(option);
      values.set(option, value);
    }
  }
  const required = [
    "--stage",
    "--base-ref",
    "--previous-head-sha",
    "--repair-permit-id",
  ];
  if (
    !required.every((option) => values.has(option)) ||
    values.get("--stage") !== "repair" ||
    lanes === 0
  )
    return false;
  for (const option of ["--previous-head-sha", "--head-sha"]) {
    const value = values.get(option);
    if (value !== undefined && !/^[0-9a-f]{40}$/i.test(value)) return false;
  }
  return true;
}
