import { TRANSFER_METADATA_LIMITS } from "@sdp/types";

export interface MetadataRow {
  key: string;
  value: string;
}

export interface MetadataRowError {
  row: number;
  message: string;
}

/**
 * Creates an empty metadata row for the editable metadata grid.
 *
 * @returns An empty key-value row.
 */
export function emptyMetadataRow(): MetadataRow {
  return { key: "", value: "" };
}

/**
 * Determines whether a metadata row has no key and no value.
 *
 * @param row - The editable metadata row.
 * @returns True when both key and value are empty.
 */
export function isEmptyMetadataRow(row: MetadataRow): boolean {
  return row.key.length === 0 && row.value.length === 0;
}

/**
 * Splits pasted newline-delimited metadata into key-value rows.
 *
 * @param text - Clipboard text containing tab- or comma-delimited rows.
 * @returns Parsed rows that contain both a key and a value.
 */
export function splitPastedMetadataRows(text: string): MetadataRow[] {
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
    .filter((row): row is MetadataRow => row !== null);
}

/**
 * Validates metadata rows against the quote API constraints. Row numbers in
 * the returned errors are 1-based positions in the supplied rows array so
 * they align with what the editing grid renders; fully empty rows are ignored.
 *
 * @param rows - Editable metadata rows to validate.
 * @returns Row-level validation errors.
 */
export function validateMetadataRows(rows: MetadataRow[]): MetadataRowError[] {
  const errors: MetadataRowError[] = [];
  const populatedRows = rows.filter((row) => !isEmptyMetadataRow(row));
  const keyCounts = new Map<string, number>();

  for (const row of populatedRows) {
    const currentCount = keyCounts.get(row.key);
    keyCounts.set(row.key, currentCount === undefined ? 1 : currentCount + 1);
  }

  rows.forEach((row, index) => {
    if (isEmptyMetadataRow(row)) {
      return;
    }
    const rowNumber = index + 1;
    if (row.key.length === 0) {
      errors.push({ row: rowNumber, message: "Key is required." });
    } else if (row.key.length > TRANSFER_METADATA_LIMITS.maxKeyLength) {
      errors.push({
        row: rowNumber,
        message: `Key must be ${TRANSFER_METADATA_LIMITS.maxKeyLength} characters or fewer.`,
      });
    } else if (keyCounts.get(row.key) !== 1) {
      errors.push({ row: rowNumber, message: "Keys must be unique." });
    }
    if (row.value.length === 0) {
      errors.push({ row: rowNumber, message: "Value is required." });
    } else if (row.value.length > TRANSFER_METADATA_LIMITS.maxValueLength) {
      errors.push({
        row: rowNumber,
        message: `Value must be ${TRANSFER_METADATA_LIMITS.maxValueLength} characters or fewer.`,
      });
    }
  });

  if (populatedRows.length > TRANSFER_METADATA_LIMITS.maxEntries) {
    errors.push({
      row: 0,
      message: `Memo can contain at most ${TRANSFER_METADATA_LIMITS.maxEntries} fields.`,
    });
  }

  return errors;
}

/**
 * Converts populated metadata rows into an API metadata record.
 *
 * @param rows - Validated editable metadata rows.
 * @returns A string-valued metadata record.
 */
export function metadataRowsToRecord(rows: MetadataRow[]): Record<string, string> {
  return Object.fromEntries(
    rows.filter((row) => !isEmptyMetadataRow(row)).map((row) => [row.key, row.value])
  );
}
