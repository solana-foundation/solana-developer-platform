/**
 * The entries of an IP allowlist as typed in a form: split on whitespace and
 * commas, each once. Empty means any address. The API validates each entry.
 */
export function parseAllowedIps(value: string): string[] {
  return Array.from(new Set(value.split(/[\s,]+/).filter((entry) => entry.length > 0)));
}
