export function commandLabels(command: string): Set<string> {
  const labels = new Set<string>();
  for (const match of command.matchAll(
    /--(?:add|remove)-label\s+["']([^"']+)["']/gi,
  ))
    for (const label of match[1]!.split(","))
      if (label.trim()) labels.add(label.trim());
  for (const match of command.matchAll(
    /--(?:add|remove)-label(?:=|\s+)([^\s,;；]+)/gi,
  ))
    for (const label of match[1]!.split(","))
      labels.add(label.replace(/[\[\]'"`]/g, ""));
  for (const match of command.matchAll(/labels(?:\[\])?=([^\s,;；]+)/gi))
    labels.add(match[1]!.replace(/[\[\]'"`]/g, ""));
  for (const match of command.matchAll(/['"]labels['"]\s*:\s*\[([^\]]*)\]/gi))
    for (const label of match[1]!.split(","))
      labels.add(label.trim().replace(/[\[\]'"`]/g, ""));
  if (
    /\/labels\b/i.test(command) &&
    !labels.size &&
    /(?:PATCH|POST|PUT|--method\s+(?:PATCH|POST|PUT)|-X\s+(?:PATCH|POST|PUT))/i.test(
      command,
    )
  )
    labels.add("__unknown_release_label__");
  return labels;
}

export function mutationTarget(command: string): {
  repo?: string | undefined;
  pr?: string | undefined;
} {
  const repo = command
    .match(
      /(?:gh\s+api\b[^\n]*\brepos\/|(?:^|\s)(?:-R|--repo)(?:=|\s+))([^\s/]+\/[^\s/]+)/i,
    )?.[1]
    ?.toLowerCase();
  const pr = command.match(
    /\/pulls\/(\d+)|(?:gh\s+pr\s+(?:edit|label)\s+)(\d+)/i,
  );
  return { repo, pr: pr?.[1] ?? pr?.[2] };
}
