export interface CliArguments {
  options: Map<string, string | true>;
  positional: string[];
}

export function parseArguments(args: string[]): CliArguments {
  const options = new Map<string, string | true>();
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === undefined || current === "--") {
      positional.push(...args.slice(index + 1));
      break;
    }
    if (!current.startsWith("--")) {
      positional.push(current);
      continue;
    }
    const option = current.slice(2);
    const separator = option.indexOf("=");
    const rawName = separator < 0 ? option : option.slice(0, separator);
    const inlineValue = separator < 0 ? undefined : option.slice(separator + 1);
    if (!rawName) throw new Error("invalid_option");
    if (inlineValue !== undefined) {
      options.set(rawName, inlineValue);
      continue;
    }
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      options.set(rawName, next);
      index += 1;
    } else {
      options.set(rawName, true);
    }
  }
  return { options, positional };
}

export function writeJson(
  value: unknown,
  stream: NodeJS.WritableStream = process.stdout,
): void {
  stream.write(`${JSON.stringify(value)}\n`);
}
