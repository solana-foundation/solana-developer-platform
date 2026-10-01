import { isWellKnownTokenSymbol } from "@sdp/types";
import type { MessageKey, TranslationValues } from "@/i18n/messages";

type Translate = (key: MessageKey, values?: TranslationValues) => string;

export interface BulkImportRow {
  accountId: string;
  currency: string;
  amount: string;
}

/** A row the import rejects, by 1-based line, and why; `bulkRowErrorMessage` words it. */
export type BulkRowError =
  | { row: number; reason: "missingWalletId" | "missingCurrency" | "invalidAmount" }
  | { row: number; reason: "duplicateWallet"; walletId: string; firstRow: number };

/**
 * The catalog wording of a rejected row's reason, without the row number the caller's
 * `Row {row}: {message}` message adds.
 */
export function bulkRowErrorMessage(error: BulkRowError, t: Translate): string {
  switch (error.reason) {
    case "missingWalletId":
      return t("DashboardPayments.batchSend.rowErrorMissingWalletId");
    case "missingCurrency":
      return t("DashboardPayments.batchSend.rowErrorMissingCurrency");
    case "invalidAmount":
      return t("DashboardPayments.batchSend.rowErrorInvalidAmount");
    case "duplicateWallet":
      return t("DashboardPayments.batchSend.rowErrorDuplicateWallet", {
        walletId: error.walletId,
        firstRow: error.firstRow,
      });
    default: {
      const exhaustive: never = error;
      return exhaustive;
    }
  }
}

export function emptyBulkRow(): BulkImportRow {
  return { accountId: "", currency: "", amount: "" };
}

export function isEmptyBulkRow(row: BulkImportRow): boolean {
  return row.accountId === "" && row.currency === "" && row.amount === "";
}

/**
 * One `wallet_id, currency_or_mint, amount` line as a row. Missing cells stay empty and cells
 * past the third stay in the amount (so `cpa_1,USDC,1,000` reads as amount `1,000`), so the
 * validator rejects a malformed line rather than the import dropping or misreading it.
 * Trailing empty cells, which spreadsheets add, are ignored.
 */
function lineToBulkRow(line: string): BulkImportRow {
  const parts = line.split(",").map((part) => part.trim());
  while (parts.length > 3 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  const [accountId = "", currency = "", ...rest] = parts;
  const upper = currency.toUpperCase();
  return {
    accountId,
    currency: isWellKnownTokenSymbol(upper) ? upper : currency,
    amount: rest.join(","),
  };
}

function nonBlankLines(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

/**
 * Split pasted text (one `wallet_id, currency_or_mint, amount` per line) into rows. Text with
 * no comma is a plain value pasted into one field, so it yields no rows; otherwise every
 * nonblank line becomes a row, malformed ones included, for the validator to flag.
 */
export function splitPastedRows(text: string): BulkImportRow[] {
  const lines = nonBlankLines(text);
  if (!lines.some((line) => line.includes(","))) {
    return [];
  }
  return lines.map(lineToBulkRow);
}

/**
 * Checks each row of an import: an account, a token, a positive amount, and each account once.
 * A batch pays an account one amount, so a second row for the same account is an error rather
 * than a silent overwrite of the first.
 */
export function validateBulkRows(rows: BulkImportRow[]): {
  valid: BulkImportRow[];
  errors: BulkRowError[];
} {
  const valid: BulkImportRow[] = [];
  const errors: BulkRowError[] = [];
  const firstRowByAccount = new Map<string, number>();

  rows.forEach((row, index) => {
    if (isEmptyBulkRow(row)) {
      return;
    }
    const line = index + 1;
    if (row.accountId.length === 0) {
      errors.push({ row: line, reason: "missingWalletId" });
      return;
    }
    if (row.currency.length === 0) {
      errors.push({ row: line, reason: "missingCurrency" });
      return;
    }
    const amount = Number(row.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      errors.push({ row: line, reason: "invalidAmount" });
      return;
    }
    const firstRow = firstRowByAccount.get(row.accountId);
    if (firstRow !== undefined) {
      errors.push({ row: line, reason: "duplicateWallet", walletId: row.accountId, firstRow });
      return;
    }
    firstRowByAccount.set(row.accountId, line);
    valid.push(row);
  });

  return { valid, errors };
}

/** The header row the batch CSV template starts with; `parseBulkCsv` skips it. */
export const BULK_CSV_HEADER = ["counterparty_wallet_id", "currency_or_mint", "amount"] as const;

/**
 * The downloadable batch template: the header and one example row, in the same three columns
 * a pasted import takes.
 */
export function bulkCsvTemplate(): string {
  return `${BULK_CSV_HEADER.join(",")}\r\ncpa_example123,USDC,25.00\r\n`;
}

/**
 * Rows from an uploaded batch CSV. Tolerates a byte-order mark, CRLF line endings, a header
 * row (skipped when its first cell is the template's first column) and blank lines. Every other
 * line becomes a row, even one with a missing cell, so `validateBulkRows` rejects the file
 * instead of the batch silently leaving that recipient out.
 *
 * @param text - The file's text.
 * @returns The rows, in file order.
 */
export function parseBulkCsv(text: string): BulkImportRow[] {
  const lines = nonBlankLines(text.replace(/^\uFEFF/, ""));
  const firstCell = lines[0]?.split(",")[0]?.trim().toLowerCase();
  const body = firstCell === BULK_CSV_HEADER[0] ? lines.slice(1) : lines;
  return body.map(lineToBulkRow);
}
