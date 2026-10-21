/**
 * data.solana.com, the API behind solana.com/data: the one place SDP reads it. Each read returns
 * every metric's preferred values, so a new Overview reading is a recipe in
 * services/network/network-snapshot.ts and rides the same read. A new product built on these
 * metrics gets its own createRefreshingCache, and with it a read of its own each refresh. How the
 * figures are read, cached and dated: docs/architecture/network-figures.md.
 */
import { providerNotConfigured, providerUnavailable } from "@/lib/errors";
import { fetchProviderJson } from "@/lib/provider-json";
import { getLogger } from "@/runtime/logger";
import { withVendorCall } from "@/runtime/vendor-calls";
import type { Env } from "@/types/env";
import { type DataApiMetricTable, dataApiMetricsResponseSchema, indexMetricRows } from "./metrics";

/** The data team's pick for each metric, one value per day: a fifth of every provider's rows,
 * with nothing to reconcile between providers that disagree. */
const METRICS_URL = "https://data.solana.com/v1/metrics?provider=preferred";
/** A year of every metric is about 110 KB gzipped; a stalled read fails rather than holding the
 * refresh. */
export const DATA_API_REQUEST_TIMEOUT_MS = 20_000;
/** Four times today's answer, counted unzipped: room for more metrics, never a runaway body. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
/** data.solana.com's name in vendor calls, logs and errors. */
const PROVIDER = "solana-data";

/**
 * The past year of every metric, by metric and closed UTC day. The API has no metric filter, so
 * each read is the whole year however few metrics the caller uses: about 110 KB gzipped. Node's
 * fetch asks for gzip and unzips it by default, so no Accept-Encoding is set here. Each read logs
 * one line, with the API's `generatedAt` to pin which copy it drew.
 *
 * @param env - The deployment's environment, which carries DATA_API_KEY.
 * @returns The metrics table.
 * @throws PROVIDER_NOT_CONFIGURED without a key; PROVIDER_UNAVAILABLE when the read fails.
 */
export async function fetchDataApiMetrics(env: Env): Promise<DataApiMetricTable> {
  const apiKey = env.DATA_API_KEY?.trim();
  if (!apiKey) {
    throw providerNotConfigured(
      "Solana network figures are not configured: DATA_API_KEY is not set for this deployment"
    );
  }
  const startedAt = Date.now();
  const table = await withVendorCall(PROVIDER, "metrics", async () => {
    const body = await fetchProviderJson(PROVIDER, METRICS_URL, dataApiMetricsResponseSchema, {
      method: "GET",
      headers: { "x-api-key": apiKey },
      timeoutMs: DATA_API_REQUEST_TIMEOUT_MS,
      maxBytes: MAX_RESPONSE_BYTES,
    });
    if (body.data.truncated) {
      throw providerUnavailable("data.solana.com returned a truncated year", {
        provider: PROVIDER,
      });
    }
    return indexMetricRows(body.data);
  });

  getLogger().info(
    {
      event: "sdp_api_data_api_read",
      generatedAt: table.generatedAt,
      metrics: table.values.size,
      rejectedRows: table.rejectedRows,
      durationMs: Date.now() - startedAt,
    },
    "read data.solana.com metrics"
  );
  if (table.rejectedRows > 0) {
    getLogger().warn(
      { event: "sdp_api_data_api_rows_rejected", rejectedRows: table.rejectedRows },
      "data.solana.com sent rows that failed validation; they were left out"
    );
  }
  return table;
}
