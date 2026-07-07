import { auth } from "@clerk/nextjs/server";
import type { AssetProfile, Token } from "@sdp/types";
import { notFound, redirect } from "next/navigation";
import { isAssetProfilesUiEnabled } from "@/lib/asset-profiles-feature";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { createTimedTrace } from "@/lib/request-tracing";
import { createSdpApiClient, type SdpApiClient } from "@/lib/sdp-api";
import { AssetManagementWorkspace } from "./asset-profile/asset-management-workspace";
import { TokenManagementWorkspace } from "./token-management-workspace";

interface TokenManagementPageProps {
  params: Promise<{
    tokenId: string;
  }>;
}

interface FetchResult<T> {
  status: number | null;
  data: T | null;
  error: string | null;
  total: number | null;
  hasMore: boolean;
}

interface PaginatedMeta {
  total?: number;
  hasMore?: boolean;
}

function parseErrorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string };
      message?: string;
    };
    return parsed?.error?.message ?? parsed?.message ?? body;
  } catch {
    return body || "Unknown error";
  }
}

async function fetchData<T>(
  request: SdpApiClient["request"],
  path: string,
  map: (payload: unknown) => T
): Promise<FetchResult<T>> {
  try {
    const response = await request(path);
    if (!response.ok) {
      const body = await response.text();
      return {
        status: response.status,
        data: null,
        error: parseErrorMessage(body),
        total: null,
        hasMore: false,
      };
    }

    const payload = (await response.json()) as {
      data?: unknown;
      meta?: PaginatedMeta;
    };

    return {
      status: response.status,
      data: map(payload?.data),
      error: null,
      total: typeof payload.meta?.total === "number" ? payload.meta.total : null,
      hasMore: payload.meta?.hasMore === true,
    };
  } catch (error) {
    return {
      status: null,
      data: null,
      error: error instanceof Error ? error.message : "Request failed",
      total: null,
      hasMore: false,
    };
  }
}

function mapToken(payload: unknown): Token | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const token = (payload as { token?: Token }).token;
  return token ?? null;
}

function mapAssetProfile(payload: unknown): AssetProfile | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const assetProfile = (payload as { assetProfile?: AssetProfile }).assetProfile;
  return assetProfile ?? null;
}

export default async function IssuanceTokenManagementPage({ params }: TokenManagementPageProps) {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const { tokenId } = await params;
  const trace = createTimedTrace("dashboard.issuance.token.page");

  try {
    const apiClient = await trace.step("create_sdp_api_client", () =>
      createSdpApiClient(trace.childContext("dashboard.issuance.token.api"))
    );

    const tokenResult = await trace.step("fetch_token", () =>
      fetchData<Token | null>(apiClient.request, `/v1/issuance/tokens/${tokenId}`, mapToken)
    );

    if (tokenResult.status === 404 || !tokenResult.data) {
      trace.log({
        ok: false,
        tokenId,
        notFound: true,
      });
      notFound();
    }

    // Tokens with an active asset profile get the new management workspace
    // (behind the asset-profiles UI flag). Any profile-fetch failure — 404 (no
    // profile), 403 (backend flag off), 5xx — degrades to the legacy workspace.
    let assetProfile: AssetProfile | null = null;
    if (isAssetProfilesUiEnabled()) {
      const profileResult = await trace.step("fetch_asset_profile", () =>
        fetchData<AssetProfile | null>(
          apiClient.request,
          `/v1/issuance/asset-profiles/by-token/${tokenId}`,
          mapAssetProfile
        )
      );
      assetProfile = profileResult.data;
      if (profileResult.error && profileResult.status !== 404) {
        trace.log({
          ok: false,
          tokenId,
          profileStatus: profileResult.status,
          profileError: profileResult.error,
        });
      }
    }

    trace.log({
      ok: true,
      tokenId,
      hasAssetProfile: assetProfile !== null,
    });

    if (assetProfile) {
      return (
        <AssetManagementWorkspace
          token={tokenResult.data}
          assetProfile={assetProfile}
          tokenError={
            tokenResult.error
              ? `Token API ${tokenResult.status ?? "unavailable"}: ${tokenResult.error}`
              : null
          }
        />
      );
    }

    return (
      <TokenManagementWorkspace
        token={tokenResult.data}
        tokenError={
          tokenResult.error
            ? `Token API ${tokenResult.status ?? "unavailable"}: ${tokenResult.error}`
            : null
        }
        authorityWallets={[]}
        authorityWalletsError={null}
        transactions={[]}
        transactionsError={null}
        transactionsTotal={null}
        transactionsHasMore={false}
        allowlistEntries={[]}
        allowlistError={null}
        allowlistTotal={null}
        allowlistHasMore={false}
        frozenAccounts={[]}
        frozenAccountsError={null}
        frozenAccountsTotal={null}
        frozenAccountsHasMore={false}
      />
    );
  } catch (error) {
    trace.log({
      ok: false,
      tokenId,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    throw error;
  }
}
