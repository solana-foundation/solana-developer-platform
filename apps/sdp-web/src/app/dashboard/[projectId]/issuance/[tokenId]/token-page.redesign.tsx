import { auth } from "@clerk/nextjs/server";
import type { AssetProfile } from "@sdp/types/asset-profiles";
import { TOKEN_TRANSACTION_STATUSES, type Token } from "@sdp/types/tokens";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { getTranslations } from "@/i18n/server";
import { readApiErrorMessage } from "@/lib/api-error";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { createTimedTrace } from "@/lib/request-tracing";
import { createSdpApiClient, type SdpApiClient } from "@/lib/sdp-api";
import type { LatestDeployAttempt } from "./token-page/token-page.shared";
import { TokenPageView } from "./token-page/token-page-view";

interface TokenPageProps {
  params: Promise<{ tokenId: string }>;
}

// The API's contract for a token and its asset profile is `Token` and `AssetProfile` in
// @sdp/types, the same types the typed client and the previous design's page use. The envelope
// and the record's identity are checked here; no second, hand-written copy of every field is
// kept beside the interface.
const tokenResponseSchema = z.object({
  data: z.object({
    token: z.custom<Token>((value) => z.object({ id: z.string() }).safeParse(value).success),
  }),
});
const assetProfileResponseSchema = z.object({
  data: z.object({
    assetProfile: z.custom<AssetProfile>(
      (value) => z.object({ tokenId: z.string() }).safeParse(value).success
    ),
  }),
});
const latestDeployResponseSchema = z.object({
  data: z.array(
    z.object({
      status: z.enum(TOKEN_TRANSACTION_STATUSES),
      error: z.string().nullable(),
      createdAt: z.string(),
    })
  ),
});

/**
 * Reads one API resource. A response that is not OK comes back with its status for the caller
 * to name; a read that throws, or a body that is not what the page expects, fails the page
 * rather than reading as an empty one.
 */
async function readResource<Schema extends z.ZodType>(
  request: SdpApiClient["request"],
  path: string,
  schema: Schema
): Promise<{ ok: true; data: z.infer<Schema> } | { ok: false; status: number; message: string }> {
  const response = await request(path);
  if (!response.ok) {
    const message = readApiErrorMessage(await response.json().catch(() => null));
    return { ok: false, status: response.status, message: message ?? response.statusText };
  }
  return { ok: true, data: schema.parse(await response.json()) };
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
  const result = await readResource(
    request,
    `/v1/issuance/tokens/${encodeURIComponent(token.id)}/transactions?type=deploy&page=1&pageSize=5`,
    latestDeployResponseSchema
  );
  if (!result.ok) {
    throw new Error(`Deploy history request failed (${result.status}): ${result.message}`);
  }
  const latest = result.data.data.reduce<LatestDeployAttempt | null>(
    (newest, attempt) =>
      newest === null || attempt.createdAt > newest.createdAt
        ? { status: attempt.status, error: attempt.error, createdAt: attempt.createdAt }
        : newest,
    null
  );
  return latest;
}

/** One token's page on the new design. */
export async function TokenPage({ params }: TokenPageProps) {
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
      readResource(apiClient.request, `/v1/issuance/tokens/${encodedId}`, tokenResponseSchema)
    ),
    trace.step("fetch_asset_profile", () =>
      readResource(
        apiClient.request,
        `/v1/issuance/asset-profiles/by-token/${encodedId}`,
        assetProfileResponseSchema
      )
    ),
  ]);

  if (!tokenResult.ok) {
    trace.log({ ok: false, tokenId, tokenStatus: tokenResult.status });
    if (tokenResult.status === 404) notFound();
    throw new Error(
      t("DashboardIssuance.errors.apiRequestFailed", {
        resource: t("DashboardIssuance.errors.tokenResource"),
        status: tokenResult.status,
        error: tokenResult.message,
      })
    );
  }
  if (!profileResult.ok) {
    trace.log({ ok: false, tokenId, profileStatus: profileResult.status });
    throw new Error(
      profileResult.status === 404
        ? t("DashboardIssuance.errors.assetProfileNotFound")
        : t("DashboardIssuance.errors.assetProfileLoadFailed", {
            status: profileResult.status,
            error: profileResult.message,
          })
    );
  }
  const token = tokenResult.data.data.token;
  const assetProfile = profileResult.data.data.assetProfile;
  const latestDeploy = await trace.step("fetch_latest_deploy", () =>
    readLatestDeploy(apiClient.request, token)
  );
  trace.log({ ok: true, tokenId, latestDeploy: latestDeploy?.status ?? null });

  return <TokenPageView token={token} assetProfile={assetProfile} latestDeploy={latestDeploy} />;
}
