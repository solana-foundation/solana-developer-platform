import type { UnifiedTransaction, UnifiedTransactionsListResponse } from "@sdp/types";
import { NextResponse } from "next/server";
import {
  parseTransactionFilters,
  toTransactionsApiQuery,
} from "@/app/dashboard/payments/transactions/transactions-query";
import { toCsv } from "@/lib/csv";
import { createSdpApiClient } from "@/lib/sdp-api";

const EXPORT_PAGE_SIZE = 100;
const MAX_EXPORT_ROWS = 5_000;

const COLUMNS: readonly (readonly [string, (transaction: UnifiedTransaction) => string | null])[] =
  [
    ["createdAt", (transaction) => transaction.createdAt],
    ["id", (transaction) => transaction.id],
    ["module", (transaction) => transaction.module],
    ["moduleId", (transaction) => transaction.moduleId],
    ["kind", (transaction) => transaction.kind],
    ["status", (transaction) => transaction.status],
    ["moduleStatus", (transaction) => transaction.moduleStatus],
    ["amount", (transaction) => transaction.amount],
    ["token", (transaction) => transaction.token],
    ["counterpartyId", (transaction) => transaction.counterpartyId],
    ["custodyWalletId", (transaction) => transaction.custodyWalletId],
    ["custodyWalletLabel", (transaction) => transaction.custodyWalletLabel],
    ["signature", (transaction) => transaction.signature],
  ];

/**
 * GET — the Transactions list as CSV, with the list's own filters (the page's query string,
 * minus paging) and every page up to {@link MAX_EXPORT_ROWS} rows, read through the same
 * cursor-paged `/v1/transactions` the list uses.
 */
export async function GET(request: Request) {
  const params = Object.fromEntries(new URL(request.url).searchParams);
  const filters = {
    ...parseTransactionFilters(params),
    cursor: undefined,
    cursors: [],
    pageSize: undefined,
  };
  const apiClient = await createSdpApiClient();
  const rows: UnifiedTransaction[] = [];
  let cursor: string | undefined;

  while (rows.length < MAX_EXPORT_ROWS) {
    const query = toTransactionsApiQuery({ ...filters, cursor }, EXPORT_PAGE_SIZE);
    const response = await apiClient.request(`/v1/transactions?${query}`);
    const body = (await response.json().catch(() => ({}))) as {
      data?: UnifiedTransactionsListResponse;
      error?: { message?: string };
    };
    if (!response.ok) {
      return NextResponse.json(
        {
          error: {
            message: body.error?.message ?? `Transaction export failed (${response.status}).`,
          },
        },
        { status: response.status }
      );
    }
    rows.push(...(body.data?.transactions ?? []).slice(0, MAX_EXPORT_ROWS - rows.length));
    const next = body.data?.nextCursor ?? null;
    if (next === null) break;
    cursor = next;
  }

  const filename = `sdp-transactions-${new Date().toISOString().slice(0, 10)}.csv`;
  return new Response(
    toCsv(
      COLUMNS.map(([header]) => header),
      rows.map((row) => COLUMNS.map(([, read]) => read(row)))
    ),
    {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    }
  );
}
