import { isWellKnownTokenSymbol } from "@sdp/types";

export interface BulkImportRow {
  accountId: string;
  currency: string;
  amount: string;
}

export interface BulkRowError {
  row: number;
  message: string;
}

export function emptyBulkRow(): BulkImportRow {
  return { accountId: "", currency: "", amount: "" };
}

export function isEmptyBulkRow(row: BulkImportRow): boolean {
  return row.accountId === "" && row.currency === "" && row.amount === "";
}

/** Split pasted text (one `wallet_id, currency_or_mint, amount` per line) into rows. */
export function splitPastedRows(text: string): BulkImportRow[] {
  return text
    .split("\n")
    .map((line) => line.split(",").map((part) => part.trim()))
    .filter((parts) => parts.length >= 3 && parts[0].length > 0)
    .map((parts) => {
      const upper = parts[1].toUpperCase();
      return {
        accountId: parts[0],
        currency: isWellKnownTokenSymbol(upper) ? upper : parts[1],
        amount: parts[2],
      };
    });
}

export function validateBulkRows(rows: BulkImportRow[]): {
  valid: BulkImportRow[];
  errors: BulkRowError[];
} {
  const valid: BulkImportRow[] = [];
  const errors: BulkRowError[] = [];

  rows.forEach((row, index) => {
    if (isEmptyBulkRow(row)) {
      return;
    }
    const line = index + 1;
    if (row.accountId.length === 0) {
      errors.push({ row: line, message: "Missing counterparty_wallet_id" });
      return;
    }
    if (row.currency.length === 0) {
      errors.push({ row: line, message: "Missing currency or mint address" });
      return;
    }
    const amount = Number(row.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      errors.push({ row: line, message: "Amount must be a positive number" });
      return;
    }
    valid.push(row);
  });

  return { valid, errors };
}
