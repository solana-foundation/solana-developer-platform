import { auth } from "@clerk/nextjs/server";
import type { AssetProfile, Token } from "@sdp/types";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { getTranslations } from "@/i18n/server";
import { readApiErrorMessage } from "@/lib/api-error";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { createTimedTrace } from "@/lib/request-tracing";
import { createSdpApiClient, type SdpApiClient } from "@/lib/sdp-api";
import { IssuanceDetailSkeleton } from "../issuance-detail-skeleton";
import { AssetManagementWorkspace } from "./asset-profile/asset-management-workspace";

interface TokenManagementPageProps {
  params: Promise<{
    tokenId: string;
  }>;
}

interface FetchResult<T> {
  status: number | null;
  data: T | null;
  error: string | null;
}

function parseErrorMessage(body: string, fallback: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    return readApiErrorMessage(parsed) ?? body;
  } catch {
    return body || fallback;
  }
}

async function fetchData<T>(
  request: SdpApiClient["request"],
  path: string,
  map: (payload: unknown) => T,
  requestFailedMessage: string,
  unknownErrorMessage: string
): Promise<FetchResult<T>> {
  try {
    const response = await request(path);
    if (!response.ok) {
      const body = await response.text();
      return {
        status: response.status,
        data: null,
        error: parseErrorMessage(body, unknownErrorMessage),
      };
    }

    const payload = (await response.json()) as {
      data?: unknown;
    };

    return {
      status: response.status,
      data: map(payload?.data),
      error: null,
    };
  } catch (error) {
    return {
      status: null,
      data: null,
      error: error instanceof Error ? error.message : requestFailedMessage,
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
  const [t, { userId, orgId }, { tokenId }] = await Promise.all([
    getTranslations(),
    auth(),
    params,
  ]);
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const trace = createTimedTrace("dashboard.issuance.token.page");

  try {
    const apiClient = await trace.step("create_sdp_api_client", () =>
      createSdpApiClient(trace.childContext("dashboard.issuance.token.api"))
    );

    const [tokenResult, profileResult] = await Promise.all([
      trace.step("fetch_token", () =>
        fetchData<Token | null>(
          apiClient.request,
          `/v1/issuance/tokens/${tokenId}`,
          mapToken,
          t("DashboardIssuance.errors.requestFailed"),
          t("DashboardIssuance.errors.unknown")
        )
      ),
      trace.step("fetch_asset_profile", () =>
        fetchData<AssetProfile | null>(
          apiClient.request,
          `/v1/issuance/asset-profiles/by-token/${tokenId}`,
          mapAssetProfile,
          t("DashboardIssuance.errors.requestFailed"),
          t("DashboardIssuance.errors.unknown")
        )
      ),
    ]);

    if (tokenResult.status === 404 || !tokenResult.data) {
      trace.log({
        ok: false,
        tokenId,
        notFound: true,
      });
      notFound();
    }

    if (!profileResult.data) {
      trace.log({
        ok: false,
        tokenId,
        profileStatus: profileResult.status,
        profileError: profileResult.error,
      });
      if (profileResult.status === 404) {
        throw new Error(t("DashboardIssuance.errors.assetProfileNotFound"));
      }
      throw new Error(
        t("DashboardIssuance.errors.assetProfileLoadFailed", {
          status: profileResult.status ?? t("DashboardIssuance.errors.unavailable"),
          error: profileResult.error ?? t("DashboardIssuance.errors.unknown"),
        })
      );
    }

    trace.log({
      ok: true,
      tokenId,
      hasAssetProfile: true,
    });

    return (
      <Suspense fallback={<IssuanceDetailSkeleton />}>
        <AssetManagementWorkspace
          token={tokenResult.data}
          assetProfile={profileResult.data}
          tokenError={null}
        />
      </Suspense>
    );
  } catch (error) {
    trace.log({
      ok: false,
      tokenId,
      error: error instanceof Error ? error.message : t("DashboardIssuance.errors.unknown"),
    });
    throw error;
  }
}
