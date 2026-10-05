import { auth } from "@clerk/nextjs/server";
import type { AssetProfile, Token, TokenTransaction } from "@sdp/types";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "@/i18n/server";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { createTimedTrace } from "@/lib/request-tracing";
import { createSdpApiClient, type SdpApiClient } from "@/lib/sdp-api";
import type { LatestDeployAttempt } from "./token-page/token-page.shared";
import { TokenPageView } from "./token-page/token-page-view";

interface TokenPageProps {
  params: Promise<{ tokenId: string }>;
}

async function readData<T>(
  request: SdpApiClient["request"],
  path: string,
  pick: (data: Record<string, unknown>) => T | undefined
): Promise<{ status: number | null; value: T | null }> {
  try {
    const response = await request(path);
    if (!response.ok) return { status: response.status, value: null };
    const body = (await response.json()) as { data?: Record<string, unknown> };
    return { status: response.status, value: body.data ? (pick(body.data) ?? null) : null };
  } catch {
    return { status: null, value: null };
  }
}

/**
 * The latest deploy attempt of a token with no mint yet: the stored token says only "not
 * deployed", so a deploy in flight or one that failed shows up here. A deployed token skips it.
 */
async function readLatestDeploy(
  request: SdpApiClient["request"],
  token: Token
): Promise<LatestDeployAttempt | null> {
  if (token.mintAddress) return null;
  try {
    const response = await request(
      `/v1/issuance/tokens/${encodeURIComponent(token.id)}/transactions?type=deploy&page=1&pageSize=5`
    );
    if (!response.ok) return null;
    const body = (await response.json()) as { data?: TokenTransaction[] };
    const latest = (body.data ?? []).reduce<TokenTransaction | null>(
      (newest, transaction) =>
        newest === null || transaction.createdAt > newest.createdAt ? transaction : newest,
      null
    );
    return latest
      ? { status: latest.status, error: latest.error, createdAt: latest.createdAt }
      : null;
  } catch {
    return null;
  }
}

/** One token's page on the new design. */
export default async function TokenPage({ params }: TokenPageProps) {
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
  const apiClient = await trace.step("create_sdp_api_client", () =>
    createSdpApiClient(trace.childContext("dashboard.issuance.token.api"))
  );
  const encodedId = encodeURIComponent(tokenId);
  const [tokenResult, profileResult] = await Promise.all([
    trace.step("fetch_token", () =>
      readData<Token>(apiClient.request, `/v1/issuance/tokens/${encodedId}`, (data) =>
        data.token ? (data.token as Token) : undefined
      )
    ),
    trace.step("fetch_asset_profile", () =>
      readData<AssetProfile>(
        apiClient.request,
        `/v1/issuance/asset-profiles/by-token/${encodedId}`,
        (data) => (data.assetProfile ? (data.assetProfile as AssetProfile) : undefined)
      )
    ),
  ]);

  const token = tokenResult.value;
  if (tokenResult.status === 404 || !token) {
    trace.log({ ok: false, tokenId, notFound: true });
    notFound();
  }
  if (!profileResult.value) {
    trace.log({ ok: false, tokenId, profileStatus: profileResult.status });
    throw new Error(
      profileResult.status === 404
        ? t("DashboardIssuance.errors.assetProfileNotFound")
        : t("DashboardIssuance.errors.assetProfileLoadFailed", {
            status: profileResult.status ?? t("DashboardIssuance.errors.unavailable"),
            error: t("DashboardIssuance.errors.unknown"),
          })
    );
  }
  const latestDeploy = await trace.step("fetch_latest_deploy", () =>
    readLatestDeploy(apiClient.request, token)
  );
  trace.log({ ok: true, tokenId, latestDeploy: latestDeploy?.status ?? null });

  return (
    <TokenPageView token={token} assetProfile={profileResult.value} latestDeploy={latestDeploy} />
  );
}
