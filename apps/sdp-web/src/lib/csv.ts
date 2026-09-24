// A cell a spreadsheet would run as a formula. Plain numbers ("-15.5") are left alone so
// amounts stay numeric.
const FORMULA_PREFIX = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^-?\d+(?:\.\d+)?$/;

function csvCell(value: string | null): string {
  if (value === null) return "";
  const guarded = FORMULA_PREFIX.test(value) && !PLAIN_NUMBER.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

/**
 * RFC 4180 CSV with CRLF line endings. Cells that would run as spreadsheet formulas are
 * prefixed with an apostrophe; null is an empty cell.
 *
 * @param header - Column names.
 * @param rows - Row cells, in header order.
 * @returns The CSV document.
 */
export function toCsv(header: readonly string[], rows: readonly (readonly (string | null)[])[]) {
  return `${[header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}
