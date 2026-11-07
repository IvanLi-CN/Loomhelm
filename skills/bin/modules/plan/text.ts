export function escapeHtml(value: string, quote: boolean): string {
  let result = value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  if (quote) result = result.replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  return result;
}
