import type { UnifiedTransaction, UnifiedTransactionsListResponse } from "@sdp/types";
import { NextResponse } from "next/server";
import {
  parseTransactionFilters,
  toTransactionsApiQuery,
} from "@/app/dashboard/payments/transactions/transactions-query.redesign";
import { toCsv } from "@/lib/csv";
import { createSdpApiClient } from "@/lib/sdp-api";

const EXPORT_PAGE_SIZE = 100;
const MAX_EXPORT_ROWS = 5_000;

// /v1/transactions admits 60 reads a minute per caller and a full export takes 50, so an export
// that follows other reads can hit the quota partway. It waits out each 429's Retry-After and
// reads that page again, up to this much waiting in all, before it gives up with a 429.
const RATE_LIMIT_WAIT_BUDGET_MS = 65_000;
// The wait when a 429 carries no usable Retry-After.
const DEFAULT_RETRY_AFTER_MS = 5_000;

// The reads plus the whole waiting budget have to fit in the function's time limit.
export const maxDuration = 120;

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
 * How long a 429 asks the caller to wait: Retry-After in seconds or as an HTTP date, at least a
 * second.
 *
 * @param header - The response's Retry-After header, if any.
 * @returns The wait in milliseconds.
 */
function retryAfterMs(header: string | null): number {
  const value = header?.trim() ?? "";
  if (value === "") return DEFAULT_RETRY_AFTER_MS;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(1_000, Math.ceil(seconds * 1_000));
  const at = Date.parse(value);
  return Number.isNaN(at) ? DEFAULT_RETRY_AFTER_MS : Math.max(1_000, at - Date.now());
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * GET — the Transactions list as CSV, with the list's own filters (the page's query string,
 * minus paging) and every page up to {@link MAX_EXPORT_ROWS} rows, read through the same
 * cursor-paged `/v1/transactions` the list uses. A page the quota refuses is read again once its
 * Retry-After has passed; when the waiting budget runs out first, the export answers 429 with
 * code `RATE_LIMITED`.
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
  let waitedMs = 0;

  while (rows.length < MAX_EXPORT_ROWS) {
    const query = toTransactionsApiQuery({ ...filters, cursor }, EXPORT_PAGE_SIZE);
    const response = await apiClient.request(`/v1/transactions?${query}`);
    if (response.status === 429) {
      const waitMs = Math.min(
        retryAfterMs(response.headers.get("Retry-After")),
        RATE_LIMIT_WAIT_BUDGET_MS - waitedMs
      );
      if (waitMs > 0) {
        await response.body?.cancel().catch(() => undefined);
        await sleep(waitMs);
        waitedMs += waitMs;
        continue;
      }
      return NextResponse.json(
        {
          error: {
            code: "RATE_LIMITED",
            message:
              "Too many transaction reads to finish the export. Wait a minute and try again.",
          },
        },
        { status: 429, headers: { "Retry-After": response.headers.get("Retry-After") ?? "60" } }
      );
    }
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
