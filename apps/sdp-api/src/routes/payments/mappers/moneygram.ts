import type { MoneygramTransferDetails } from "@sdp/types";
import type { PaymentTransferRow } from "@/db/repositories/payments.repository";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function mapMoneygramTransferDetails(
  row: PaymentTransferRow
): MoneygramTransferDetails | undefined {
  if (row.provider !== "moneygram") {
    return undefined;
  }

  const moneygram = asRecord(row.provider_data.moneygram);
  if (!moneygram) {
    return undefined;
  }

  const transactionId = readString(moneygram, "transactionId");
  const referenceNumber = readString(moneygram, "referenceNumber");
  const payoutAmount = readNumber(moneygram, "payoutAmount");
  const payoutStatus = readString(moneygram, "payoutStatus");
  const cryptoTransferId = readString(moneygram, "cryptoTransferId");
  const solanaTxSignature = readString(moneygram, "solanaTxSignature");
  const lastWidgetError = readString(moneygram, "lastWidgetError");
  const details: MoneygramTransferDetails = {
    ...(transactionId ? { transactionId } : {}),
    ...(referenceNumber ? { referenceNumber } : {}),
    ...(payoutAmount !== undefined ? { payoutAmount } : {}),
    ...(payoutStatus ? { payoutStatus } : {}),
    ...(cryptoTransferId ? { cryptoTransferId } : {}),
    ...(solanaTxSignature ? { solanaTxSignature } : {}),
    ...(lastWidgetError ? { lastWidgetError } : {}),
  };

  return Object.keys(details).length > 0 ? details : undefined;
}
