import { NextResponse } from "next/server";
import { z } from "zod";
import { fetchPaymentsWallets } from "@/app/dashboard/payments/payments-page.data";
import { createTimedTrace, logRouteResult } from "@/lib/request-tracing";
import { createSdpApiClient, type SdpApiClient } from "@/lib/sdp-api";

const authorityResponseSchema = z.object({
  data: z.object({ allowlistAuthority: z.string().min(1).nullable() }),
});
const freezeAuthorityResponseSchema = z.object({
  data: z.object({ freezeAuthority: z.string().min(1).nullable() }),
});
const metadataAuthorityResponseSchema = z.object({
  data: z.object({ metadataAuthority: z.string().min(1).nullable() }),
});
const pauseAuthorityResponseSchema = z.object({
  data: z.object({ pauseAuthority: z.string().min(1).nullable() }),
});
const operationAuthoritiesResponseSchema = z.object({
  data: z.object({
    allowlistAuthority: z.string().min(1).nullable(),
    freezeAuthority: z.string().min(1).nullable(),
    metadataAuthority: z.string().min(1).nullable(),
    pauseAuthority: z.string().min(1).nullable(),
  }),
});

type OperationAuthorities = {
  allowlistAuthority: string | null;
  allowlistAuthorityError: string | null;
  freezeAuthority: string | null;
  freezeAuthorityError: string | null;
  metadataAuthority: string | null;
  metadataAuthorityError: string | null;
  pauseAuthority: string | null;
  pauseAuthorityError: string | null;
};

async function fetchOperationAuthorities(
  request: SdpApiClient["request"],
  tokenId: string
): Promise<OperationAuthorities> {
  const tokenPath = `/v1/issuance/tokens/${encodeURIComponent(tokenId)}`;
  try {
    const response = await request(
      `${tokenPath}?includeAllowlistAuthority=true&includeFreezeAuthority=true&includeMetadataAuthority=true&includePauseAuthority=true`,
      { method: "GET" }
    );
    if (!response.ok) throw new Error(`Authority API ${response.status}`);
    const body = operationAuthoritiesResponseSchema.parse(await response.json());
    return {
      allowlistAuthority: body.data.allowlistAuthority,
      allowlistAuthorityError: null,
      freezeAuthority: body.data.freezeAuthority,
      freezeAuthorityError: null,
      metadataAuthority: body.data.metadataAuthority,
      metadataAuthorityError: null,
      pauseAuthority: body.data.pauseAuthority,
      pauseAuthorityError: null,
    };
  } catch {
    // Keep operations independent when one live resolver fails. The healthy path
    // uses one API request; only the error path fans out to identify the blocker.
    const [allowlist, freeze, metadata, pause] = await Promise.all([
      fetchAllowlistAuthority(request, tokenPath),
      fetchFreezeAuthority(request, tokenPath),
      fetchMetadataAuthority(request, tokenPath),
      fetchPauseAuthority(request, tokenPath),
    ]);
    return { ...allowlist, ...freeze, ...metadata, ...pause };
  }
}

async function fetchAllowlistAuthority(request: SdpApiClient["request"], tokenPath: string) {
  try {
    const response = await request(`${tokenPath}?includeAllowlistAuthority=true`, {
      method: "GET",
    });
    if (!response.ok) throw new Error(`Allowlist authority API ${response.status}`);
    const body = authorityResponseSchema.parse(await response.json());
    return { allowlistAuthority: body.data.allowlistAuthority, allowlistAuthorityError: null };
  } catch (error) {
    return {
      allowlistAuthority: null,
      allowlistAuthorityError:
        error instanceof Error ? error.message : "Unable to load allowlist authority",
    };
  }
}

async function fetchFreezeAuthority(request: SdpApiClient["request"], tokenPath: string) {
  try {
    const response = await request(`${tokenPath}?includeFreezeAuthority=true`, { method: "GET" });
    if (!response.ok) throw new Error(`Freeze authority API ${response.status}`);
    const body = freezeAuthorityResponseSchema.parse(await response.json());
    return { freezeAuthority: body.data.freezeAuthority, freezeAuthorityError: null };
  } catch (error) {
    return {
      freezeAuthority: null,
      freezeAuthorityError:
        error instanceof Error ? error.message : "Unable to load freeze authority",
    };
  }
}

async function fetchMetadataAuthority(request: SdpApiClient["request"], tokenPath: string) {
  try {
    const response = await request(`${tokenPath}?includeMetadataAuthority=true`, { method: "GET" });
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
}

async function fetchPauseAuthority(request: SdpApiClient["request"], tokenPath: string) {
  try {
    const response = await request(`${tokenPath}?includePauseAuthority=true`, { method: "GET" });
    if (!response.ok) throw new Error(`Pause authority API ${response.status}`);
    const body = pauseAuthorityResponseSchema.parse(await response.json());
    return { pauseAuthority: body.data.pauseAuthority, pauseAuthorityError: null };
  } catch (error) {
    return {
      pauseAuthority: null,
      pauseAuthorityError:
        error instanceof Error ? error.message : "Unable to load pause authority",
    };
  }
}

export async function GET(request: Request, { params }: { params: Promise<{ tokenId: string }> }) {
  const trace = createTimedTrace("route.dashboard.issuance.token.authority_wallets", request);

  try {
    const { tokenId } = await params;
    const apiClient = await createSdpApiClient(
      trace.childContext("route.dashboard.issuance.token.authority_wallets.api")
    );

    const [walletsResult, operationAuthorities] = await Promise.all([
      trace.step("fetch_authority_wallets", () =>
        fetchPaymentsWallets(apiClient.request, { view: "summary", includeBalances: false })
      ),
      trace.step("fetch_operation_authorities", () =>
        fetchOperationAuthorities(apiClient.request, tokenId)
      ),
    ]);

    const response = NextResponse.json(
      {
        data: {
          ...operationAuthorities,
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
