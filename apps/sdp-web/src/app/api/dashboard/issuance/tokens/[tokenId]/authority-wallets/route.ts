import { NextResponse } from "next/server";
import { z } from "zod";
import { fetchPaymentsWallets } from "@/app/dashboard/payments/payments-page.data";
import { createTimedTrace, logRouteResult } from "@/lib/request-tracing";
import { createSdpApiClient } from "@/lib/sdp-api";

const authorityResponseSchema = z.object({
  data: z.object({ allowlistAuthority: z.string().min(1).nullable() }),
});
const metadataAuthorityResponseSchema = z.object({
  data: z.object({ metadataAuthority: z.string().min(1).nullable() }),
});

export async function GET(request: Request, { params }: { params: Promise<{ tokenId: string }> }) {
  const trace = createTimedTrace("route.dashboard.issuance.token.authority_wallets", request);

  try {
    const { tokenId } = await params;
    const apiClient = await createSdpApiClient(
      trace.childContext("route.dashboard.issuance.token.authority_wallets.api")
    );

    const [walletsResult, allowlistAuthorityResult, metadataAuthorityResult] = await Promise.all([
      trace.step("fetch_authority_wallets", () =>
        fetchPaymentsWallets(apiClient.request, { view: "summary", includeBalances: false })
      ),
      trace.step("fetch_allowlist_authority", async () => {
        try {
          const response = await apiClient.request(
            `/v1/issuance/tokens/${encodeURIComponent(tokenId)}?includeAllowlistAuthority=true`,
            { method: "GET" }
          );
          if (!response.ok) throw new Error(`Allowlist authority API ${response.status}`);
          const body = authorityResponseSchema.parse(await response.json());
          return {
            allowlistAuthority: body.data.allowlistAuthority,
            allowlistAuthorityError: null,
          };
        } catch (error) {
          return {
            allowlistAuthority: null,
            allowlistAuthorityError:
              error instanceof Error ? error.message : "Unable to load allowlist authority",
          };
        }
      }),
      trace.step("fetch_metadata_authority", async () => {
        try {
          // Keep the reads separate: a broken list must not block metadata edits.
          const response = await apiClient.request(
            `/v1/issuance/tokens/${encodeURIComponent(tokenId)}?includeMetadataAuthority=true`,
            { method: "GET" }
          );
          if (!response.ok) throw new Error(`Metadata authority API ${response.status}`);
          const body = metadataAuthorityResponseSchema.parse(await response.json());
          return { metadataAuthority: body.data.metadataAuthority, metadataAuthorityError: null };
        } catch (error) {
          return {
            metadataAuthority: null,
            metadataAuthorityError:
              error instanceof Error ? error.message : "Unable to load metadata authority",
          };
        }
      }),
    ]);

    const response = NextResponse.json(
      {
        data: {
          ...allowlistAuthorityResult,
          ...metadataAuthorityResult,
          authorityWallets: walletsResult.data ?? [],
          authorityWalletsError: walletsResult.ok
            ? null
            : `Wallet API ${walletsResult.status ?? "unavailable"}: ${walletsResult.error ?? "Unknown error"}`,
        },
      },
      {
        headers: {
          "X-SDP-Trace-ID": trace.traceId,
          "Server-Timing": trace.serverTiming(),
        },
      }
    );

    logRouteResult(trace, 200, {
      tokenId,
      authorityWalletCount: walletsResult.data?.length ?? 0,
    });

    return response;
  } catch (error) {
    const response = NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to load authority wallets",
      },
      {
        status: 500,
        headers: {
          "X-SDP-Trace-ID": trace.traceId,
          "Server-Timing": trace.serverTiming(),
        },
      }
    );

    logRouteResult(trace, 500, {
      error: error instanceof Error ? error.message : "Failed to load authority wallets",
    });

    return response;
  }
}
