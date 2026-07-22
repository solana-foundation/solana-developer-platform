import { auth } from "@clerk/nextjs/server";
import type { AssetCategory, IssuanceMetadata } from "@sdp/types";
import { redirect } from "next/navigation";
import { getTranslations } from "@/i18n/server";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { createTimedTrace } from "@/lib/request-tracing";
import { createSdpApiClient, type SdpApiClient } from "@/lib/sdp-api";
import { fetchPaymentsWallets } from "../../payments/payments-page.data";
import { fetchActiveApiKeys, resolvePlaygroundApiBaseUrl } from "../../playground-api-data";
import { IssuanceWorkspace } from "../issuance-workspace";

interface IssuanceTemplateView {
  id: string;
  name: string;
  description?: string;
}

interface IssuanceAssetProfileView {
  assetCategory: AssetCategory;
  assetType: string;
  assetTypeVersion: number;
  issuanceMetadata: IssuanceMetadata;
}

interface IssuanceTokenView {
  id: string;
  name: string;
  symbol: string;
  status: string;
  template: string;
  imageUrl: string | null;
  mintAddress: string | null;
  totalSupply: string;
  createdAt: string;
  deployedAt: string | null;
  // Extended fields (already returned by /v1/issuance/tokens as full Token rows;
  // previously dropped) — power the collapsible list view's expanded card.
  decimals: number;
  maxSupply: string | null;
  isMintable: boolean;
  isFreezable: boolean;
  requiresAllowlist: boolean;
  description: string | null;
  uri: string | null;
  signingWalletId: string | null;
  // Merged from /v1/issuance/asset-profiles by tokenId; null for legacy tokens
  // without a profile (list falls back to core fields).
  assetProfile: IssuanceAssetProfileView | null;
}

interface FetchResult<T> {
  ok: boolean;
  status?: number;
  data?: T;
  error?: string;
}

function resolveTokenListNotice(
  result: FetchResult<IssuanceTokenView[]>,
  t: Awaited<ReturnType<typeof getTranslations>>
): string | null {
  if (result.ok) {
    return null;
  }

  if (typeof result.status === "number" && result.status >= 400 && result.status < 500) {
    return t("DashboardIssuance.errors.tokenListRetry");
  }

  return t("DashboardIssuance.errors.tokenListCreateOrRetry");
}

function parseErrorMessage(body: string, fallback: string): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string };
      message?: string;
    };
    return (parsed?.error?.message ?? parsed?.message ?? body) || fallback;
  } catch {
    return body || fallback;
  }
}

async function fetchTemplates(
  request: SdpApiClient["request"],
  t: Awaited<ReturnType<typeof getTranslations>>
): Promise<FetchResult<IssuanceTemplateView[]>> {
  try {
    const response = await request("/v1/issuance/templates");
    if (!response.ok) {
      const body = await response.text();
      return {
        ok: false,
        status: response.status,
        error: parseErrorMessage(body, t("DashboardIssuance.errors.unknown")),
      };
    }

    const json = (await response.json()) as {
      data?: {
        templates?: Array<{ id?: string; name?: string; description?: string }>;
      };
    };

    const templates = (json?.data?.templates ?? [])
      .filter((entry): entry is { id: string; name: string; description?: string } => {
        return typeof entry.id === "string" && typeof entry.name === "string";
      })
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        description: entry.description,
      }));

    return { ok: true, data: templates };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : t("DashboardIssuance.errors.unableToLoadTemplates"),
    };
  }
}

async function fetchTokens(
  request: SdpApiClient["request"],
  t: Awaited<ReturnType<typeof getTranslations>>
): Promise<FetchResult<IssuanceTokenView[]>> {
  try {
    const tokensPath = `/v1/issuance/tokens?${new URLSearchParams({
      page: "1",
      pageSize: "100",
    }).toString()}`;
    const response = await request(tokensPath);
    if (!response.ok) {
      const body = await response.text();
      return {
        ok: false,
        status: response.status,
        error: parseErrorMessage(body, t("DashboardIssuance.errors.unknown")),
      };
    }

    const json = (await response.json()) as {
      data?: Array<{
        id?: string;
        name?: string;
        symbol?: string;
        status?: string;
        template?: string;
        imageUrl?: string | null;
        mintAddress?: string | null;
        totalSupply?: string;
        createdAt?: string;
        deployedAt?: string | null;
        decimals?: number;
        maxSupply?: string | null;
        isMintable?: boolean;
        isFreezable?: boolean;
        requiresAllowlist?: boolean;
        description?: string | null;
        uri?: string | null;
        signingWalletId?: string | null;
      }>;
    };

    const tokens = (json?.data ?? [])
      .filter((token): token is NonNullable<typeof token> => Boolean(token?.id))
      .map((token) => ({
        id: token.id ?? "",
        name: token.name ?? t("DashboardIssuance.management.untitledToken"),
        symbol: token.symbol ?? "-",
        status: token.status ?? "pending",
        template: token.template ?? "custom",
        imageUrl: token.imageUrl ?? null,
        mintAddress: token.mintAddress ?? null,
        totalSupply: token.totalSupply ?? "0",
        createdAt: token.createdAt ?? "",
        deployedAt: token.deployedAt ?? null,
        decimals: typeof token.decimals === "number" ? token.decimals : 0,
        maxSupply: token.maxSupply ?? null,
        isMintable: token.isMintable ?? false,
        isFreezable: token.isFreezable ?? false,
        requiresAllowlist: token.requiresAllowlist ?? false,
        description: token.description ?? null,
        uri: token.uri ?? null,
        signingWalletId: token.signingWalletId ?? null,
        assetProfile: null as IssuanceAssetProfileView | null,
      }));

    return { ok: true, data: tokens };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error ? error.message : t("DashboardIssuance.errors.unableToLoadTokens"),
    };
  }
}

// Best-effort fetch of asset profiles for the whole project in one call, keyed by
// tokenId for merging into the token list. This powers the type-aware expanded
// card in the list view. Soft-fails to an empty map (e.g. the asset-profiles
// feature flag being off returns 403) so the page never blocks on it.
async function fetchAssetProfiles(
  request: SdpApiClient["request"]
): Promise<Map<string, IssuanceAssetProfileView>> {
  const byTokenId = new Map<string, IssuanceAssetProfileView>();
  try {
    const path = `/v1/issuance/asset-profiles?${new URLSearchParams({
      page: "1",
      pageSize: "100",
    }).toString()}`;
    const response = await request(path);
    if (!response.ok) {
      return byTokenId;
    }

    const json = (await response.json()) as {
      data?: {
        assetProfiles?: Array<{
          tokenId?: string;
          assetCategory?: AssetCategory;
          assetType?: string;
          assetTypeVersion?: number;
          issuanceMetadata?: IssuanceMetadata;
        }>;
      };
    };

    for (const profile of json?.data?.assetProfiles ?? []) {
      if (!profile?.tokenId || !profile.assetCategory || !profile.assetType) {
        continue;
      }
      byTokenId.set(profile.tokenId, {
        assetCategory: profile.assetCategory,
        assetType: profile.assetType,
        assetTypeVersion: profile.assetTypeVersion ?? 1,
        issuanceMetadata: profile.issuanceMetadata ?? {},
      });
    }
  } catch {
    // Ignore — the list still renders with core fields only.
  }
  return byTokenId;
}

interface IssuancePageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

export default async function IssuancePage({ searchParams }: IssuancePageProps) {
  const [t, { userId, orgId }, resolvedSearchParams] = await Promise.all([
    getTranslations(),
    auth(),
    searchParams ?? Promise.resolve(undefined),
  ]);
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const trace = createTimedTrace("dashboard.issuance.page");

  try {
    const currentTab =
      resolvedSearchParams?.tab === "playground" ||
      (Array.isArray(resolvedSearchParams?.tab) && resolvedSearchParams.tab[0] === "playground")
        ? "playground"
        : "tokens";
    const apiBaseUrl = resolvePlaygroundApiBaseUrl();
    const apiClient = await trace.step("create_sdp_api_client", () =>
      createSdpApiClient(trace.childContext("dashboard.issuance.api"))
    );
    const [
      templatesResult,
      tokensResult,
      assetProfilesByTokenId,
      apiKeysResult,
      signerWalletsResult,
    ] = await Promise.all([
      trace.step("fetch_templates", () => fetchTemplates(apiClient.request, t)),
      trace.step("fetch_tokens", () => fetchTokens(apiClient.request, t)),
      trace.step("fetch_asset_profiles", () => fetchAssetProfiles(apiClient.request)),
      trace.step("fetch_active_api_keys", () => fetchActiveApiKeys(apiClient.request)),
      trace.step("fetch_signer_wallets", () =>
        fetchPaymentsWallets(apiClient.request, { view: "summary" })
      ),
    ]);

    const tokens = (tokensResult.data ?? []).map((token) => ({
      ...token,
      assetProfile: assetProfilesByTokenId.get(token.id) ?? null,
    }));
    const apiKeys = apiKeysResult.data ?? [];
    const templatesError = templatesResult.ok
      ? null
      : t("DashboardIssuance.errors.apiRequestFailed", {
          resource: t("DashboardIssuance.errors.templateResource"),
          status: templatesResult.status ?? t("DashboardIssuance.errors.unavailable"),
          error: templatesResult.error ?? t("DashboardIssuance.errors.unknown"),
        });

    trace.log({
      ok: true,
      tab: currentTab,
      tokenCount: tokens.length,
      templateCount: templatesResult.data?.length ?? 0,
      apiKeyCount: apiKeys.length,
      signerWalletCount: signerWalletsResult.data?.length ?? 0,
    });

    return (
      <IssuanceWorkspace
        tokens={tokens}
        templates={templatesResult.data ?? []}
        apiKeys={apiKeys}
        signerWallets={signerWalletsResult.data ?? []}
        apiBaseUrl={apiBaseUrl}
        templatesError={templatesError}
        tokensNotice={resolveTokenListNotice(tokensResult, t)}
        signerWalletsError={
          signerWalletsResult.ok
            ? null
            : t("DashboardIssuance.errors.apiRequestFailed", {
                resource: t("DashboardIssuance.errors.walletResource"),
                status: signerWalletsResult.status ?? t("DashboardIssuance.errors.unavailable"),
                error: signerWalletsResult.error ?? t("DashboardIssuance.errors.unknown"),
              })
        }
      />
    );
  } catch (error) {
    trace.log({
      ok: false,
      error: error instanceof Error ? error.message : t("DashboardIssuance.errors.unknown"),
    });
    throw error;
  }
}
