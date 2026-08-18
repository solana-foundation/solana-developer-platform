import { NextResponse } from "next/server";
import { parseIssuanceListQuery } from "@/app/dashboard/issuance/issuance-list-query";
import {
  attachIssuanceAssetProfiles,
  fetchIssuanceTokensPage,
  type IssuanceTokensPage,
} from "@/app/dashboard/issuance/issuance-tokens.data";
import { assetProfiles } from "@/flags";
import { createTimedTrace } from "@/lib/request-tracing";
import { createSdpApiClient } from "@/lib/sdp-api";

// Paged asset list for the issuance workspace. The workspace re-fetches through
// here on every search/filter/sort/page change, so a keystroke costs one token
// query instead of an RSC round-trip that would also re-fetch templates, API
// keys and signer wallets.
//
// Query params use the same vocabulary as the page URL (search/status/template/
// date/sort/page/pageSize) and are parsed by the same tolerant parser: unknown
// or out-of-range values fall back to defaults rather than erroring, and the
// pageSize clamp bounds what a crafted request can ask the API for.

interface IssuanceTokensRouteResponse extends Omit<IssuanceTokensPage, "tokens" | "status"> {
  data: IssuanceTokensPage["tokens"];
}

function emptyResponse(
  page: number,
  pageSize: number,
  error: string | null
): IssuanceTokensRouteResponse {
  return { data: [], total: 0, page, pageSize, hasMore: false, error };
}

export async function GET(request: Request) {
  const trace = createTimedTrace("route.dashboard.issuance.tokens", request);
  const query = parseIssuanceListQuery(new URL(request.url).searchParams);

  try {
    const [apiClient, assetProfilesEnabled] = await Promise.all([
      createSdpApiClient(trace.childContext("route.dashboard.issuance.tokens.api")),
      assetProfiles(),
    ]);

    const page = await trace.step("fetch_tokens_page", () =>
      fetchIssuanceTokensPage(apiClient.request, query)
    );

    if (page.error) {
      trace.log({ ok: false, error: page.error, status: page.status ?? 500 });
      return NextResponse.json(emptyResponse(page.page, page.pageSize, page.error), {
        // A failed upstream call is reported with its own status so the client can
        // tell "your filters are bad" from "the API is down".
        status: page.status ?? 500,
      });
    }

    const tokens = assetProfilesEnabled
      ? await trace.step("attach_asset_profiles", () =>
          attachIssuanceAssetProfiles(apiClient.request, page.tokens)
        )
      : page.tokens;

    trace.log({
      ok: true,
      resultCount: tokens.length,
      total: page.total,
      page: page.page,
      pageSize: page.pageSize,
    });

    return NextResponse.json({
      data: tokens,
      total: page.total,
      page: page.page,
      pageSize: page.pageSize,
      hasMore: page.hasMore,
      error: null,
    } satisfies IssuanceTokensRouteResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Request failed";
    trace.log({ ok: false, error: message });
    return NextResponse.json(emptyResponse(query.page, query.pageSize, message), { status: 500 });
  }
}
