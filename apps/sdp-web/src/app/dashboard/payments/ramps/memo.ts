import { RAMPS_MEMO_LIMITS } from "@sdp/types";

export interface MemoRow {
  key: string;
  value: string;
}

export interface MemoRowError {
  row: number;
  message: string;
}

/**
 * Creates an empty memo row for the editable memo grid.
 *
 * @returns An empty key-value row.
 */
export function emptyMemoRow(): MemoRow {
  return { key: "", value: "" };
}

/**
 * Determines whether a memo row has no key and no value.
 *
 * @param row - The editable memo row.
 * @returns True when both key and value are empty.
 */
export function isEmptyMemoRow(row: MemoRow): boolean {
  return row.key.length === 0 && row.value.length === 0;
}

/**
 * Splits pasted newline-delimited memo into key-value rows.
 *
 * @param text - Clipboard text containing tab- or comma-delimited rows.
 * @returns Parsed rows that contain both a key and a value.
 */
export function splitPastedMemoRows(text: string): MemoRow[] {
  return text
    .split("\n")
    .map((line) => {
      const tabIndex = line.indexOf("\t");
      const commaIndex = line.indexOf(",");
      const separatorIndex = tabIndex >= 0 ? tabIndex : commaIndex;
      if (separatorIndex < 0) {
        return null;
      }
      const key = line.slice(0, separatorIndex).trim();
      const value = line.slice(separatorIndex + 1).trim();
      return key.length > 0 && value.length > 0 ? { key, value } : null;
    })
    .filter((row): row is MemoRow => row !== null);
}

/**
 * Validates memo rows against the quote API constraints. Row numbers in
 * the returned errors are 1-based positions in the supplied rows array so
 * they align with what the editing grid renders; fully empty rows are ignored.
 *
 * @param rows - Editable memo rows to validate.
 * @returns Row-level validation errors.
 */
export function validateMemoRows(rows: MemoRow[]): MemoRowError[] {
  const errors: MemoRowError[] = [];
  const populatedRows = rows.filter((row) => !isEmptyMemoRow(row));
  const keyCounts = new Map<string, number>();

  for (const row of populatedRows) {
    const currentCount = keyCounts.get(row.key);
    keyCounts.set(row.key, currentCount === undefined ? 1 : currentCount + 1);
  }

  rows.forEach((row, index) => {
    if (isEmptyMemoRow(row)) {
      return;
    }
    const rowNumber = index + 1;
    if (row.key.length === 0) {
      errors.push({ row: rowNumber, message: "Key is required." });
    } else if (row.key.length > RAMPS_MEMO_LIMITS.maxKeyLength) {
      errors.push({
        row: rowNumber,
        message: `Key must be ${RAMPS_MEMO_LIMITS.maxKeyLength} characters or fewer.`,
      });
    } else if (keyCounts.get(row.key) !== 1) {
      errors.push({ row: rowNumber, message: "Keys must be unique." });
    }
    if (row.value.length === 0) {
      errors.push({ row: rowNumber, message: "Value is required." });
    } else if (row.value.length > RAMPS_MEMO_LIMITS.maxValueLength) {
      errors.push({
        row: rowNumber,
        message: `Value must be ${RAMPS_MEMO_LIMITS.maxValueLength} characters or fewer.`,
      });
    }
  });

  if (populatedRows.length > RAMPS_MEMO_LIMITS.maxEntries) {
    errors.push({
      row: 0,
      message: `Memo can contain at most ${RAMPS_MEMO_LIMITS.maxEntries} fields.`,
    });
  }

  return errors;
}

/**
 * Converts populated memo rows into an API memo record.
 *
 * @param rows - Validated editable memo rows.
 * @returns A string-valued memo record.
 */
export function memoRowsToRecord(rows: MemoRow[]): Record<string, string> {
  return Object.fromEntries(
    rows.filter((row) => !isEmptyMemoRow(row)).map((row) => [row.key, row.value])
  );
}
