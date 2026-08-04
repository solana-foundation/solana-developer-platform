export function escapeMarkdownTableCell(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\r\n?|\n/g, " ")
    .replace(/\|/g, "\\|");
}
