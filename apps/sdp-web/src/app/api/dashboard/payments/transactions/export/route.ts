import type { PaymentTransferSummary } from "@sdp/types";
import { NextResponse } from "next/server";
import {
  parseTransactionFilters,
  toTransactionsApiQuery,
} from "@/app/dashboard/payments/transactions/transactions-query";
import { createSdpApiClient } from "@/lib/sdp-api";

const EXPORT_PAGE_SIZE = 100;
const MAX_EXPORT_ROWS = 10_000;

export async function GET(request: Request) {
  const apiClient = await createSdpApiClient();
  const url = new URL(request.url);
  const filters = parseTransactionFilters(Object.fromEntries(url.searchParams), new Date());
  const transfers: PaymentTransferSummary[] = [];
  let totalPages = Math.ceil(MAX_EXPORT_ROWS / EXPORT_PAGE_SIZE);

  for (let page = 1; page <= totalPages; page += 1) {
    const query = toTransactionsApiQuery({ ...filters, page, pageSize: EXPORT_PAGE_SIZE });
    const response = await apiClient.request(`/v1/payments/transfers?${query}`);
    const body = (await response.json().catch(() => ({}))) as {
      data?: PaymentTransferSummary[];
      meta?: { total?: number; hasMore?: boolean };
      error?: { message?: string };
    };

    if (!response.ok) {
      return NextResponse.json(
        {
          error: {
            message:
              body.error?.message ?? `Transaction export request failed (${response.status}).`,
          },
        },
        { status: response.status }
      );
    }

    if (page === 1) {
      const cappedTotal =
        typeof body.meta?.total === "number" ? Math.min(body.meta.total, MAX_EXPORT_ROWS) : null;
      totalPages =
        cappedTotal === null ? totalPages : Math.max(1, Math.ceil(cappedTotal / EXPORT_PAGE_SIZE));
    }

    transfers.push(...(body.data ?? []).slice(0, MAX_EXPORT_ROWS - transfers.length));
    if (!body.meta?.hasMore) {
      break;
    }
  }

  const filename = `sdp-transactions-export-${new Date().toISOString().slice(0, 10)}.csv`;
  return new Response(toCsv(transfers), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

const COLUMNS = [
  ["id", (transfer: PaymentTransferSummary) => transfer.id],
  ["createdAt", (transfer) => transfer.createdAt],
  ["updatedAt", (transfer) => transfer.updatedAt],
  ["type", (transfer) => transfer.type],
  ["status", (transfer) => transfer.status],
  ["direction", (transfer) => transfer.direction],
  ["amount", (transfer) => transfer.amount],
  ["token", (transfer) => transfer.token],
  ["walletId", (transfer) => transfer.walletId],
  ["counterpartyId", (transfer) => transfer.counterpartyId],
  ["source", (transfer) => transfer.source],
  ["destination", (transfer) => transfer.destination],
  ["provider", (transfer) => transfer.provider],
  ["providerReference", (transfer) => transfer.providerReference],
  ["signature", (transfer) => transfer.signature],
  ["memo", (transfer) => transfer.memo],
] as const satisfies readonly [
  string,
  (transfer: PaymentTransferSummary) => string | null | undefined,
][];

const SPREADSHEET_FORMULA_PREFIXES = new Set(["=", "+", "-", "@"]);

function toCsv(transfers: PaymentTransferSummary[]): string {
  const rows = [
    COLUMNS.map(([header]) => header).join(","),
    ...transfers.map((transfer) =>
      COLUMNS.map(([, read]) => escapeCsvValue(read(transfer))).join(",")
    ),
  ];
  return `${rows.join("\n")}\n`;
}

function escapeCsvValue(value: string | null | undefined): string {
  if (value === null || value === undefined) {
    return "";
  }

  const safeValue = isSpreadsheetFormulaValue(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safeValue) ? `"${safeValue.replaceAll('"', '""')}"` : safeValue;
}

function isSpreadsheetFormulaValue(value: string): boolean {
  const normalizedValue = value.replace(/^[\p{Cc}\p{Cf}\p{Z}]+/u, "");
  return SPREADSHEET_FORMULA_PREFIXES.has(normalizedValue[0]);
}
