const apiValueOptions = new Set([
  "--cache",
  "--field",
  "-F",
  "--header",
  "-H",
  "--hostname",
  "--input",
  "--jq",
  "--method",
  "-X",
  "--preview",
  "--raw-field",
  "-f",
  "--template",
]);
const apiInlineValuePrefixes = [
  "--cache=",
  "--field=",
  "-F=",
  "--header=",
  "-H=",
  "--hostname=",
  "--input=",
  "--jq=",
  "--method=",
  "-X=",
  "--preview=",
  "--raw-field=",
  "-f=",
  "--template=",
];
const apiEndpointPattern =
  /^\/?repos\/([^/\s]+)\/([^/\s]+)\/pulls(?:\/([1-9][0-9]*))?\/?$/i;

export function apiEndpoint(tokens: string[]): RegExpMatchArray | undefined {
  let endpoint: RegExpMatchArray | undefined;
  for (let index = 2; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--help" || token === "-h") return undefined;
    if (apiValueOptions.has(token)) {
      const value = tokens[index + 1];
      if (!value || value.startsWith("-")) return undefined;
      index += 1;
      continue;
    }
    const inlineOption = apiInlineValuePrefixes.find((prefix) =>
      token.startsWith(prefix),
    );
    if (inlineOption) {
      const value = token.slice(inlineOption.length);
      if (!value || value.startsWith("-")) return undefined;
      continue;
    }
    if (token.startsWith("-")) return undefined;
    const match = token.match(apiEndpointPattern);
    if (!match || endpoint) return undefined;
    endpoint = match;
  }
  return endpoint;
}
