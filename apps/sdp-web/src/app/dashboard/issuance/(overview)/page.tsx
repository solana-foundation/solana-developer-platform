import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { assetProfiles } from "@/flags";
import { getTranslations } from "@/i18n/server";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { createTimedTrace } from "@/lib/request-tracing";
import { createSdpApiClient, type SdpApiClient } from "@/lib/sdp-api";
import { fetchPaymentsWallets } from "../../payments/payments-page.data";
import { fetchActiveApiKeys, resolvePlaygroundApiBaseUrl } from "../../playground-api-data";
import { parseIssuanceListQuery } from "../issuance-list-query";
import {
  attachIssuanceAssetProfiles,
  fetchIssuanceTokenFacets,
  fetchIssuanceTokensPage,
} from "../issuance-tokens.data";
import { IssuanceWorkspace } from "../issuance-workspace";

interface IssuanceTemplateView {
  id: string;
  name: string;
  description?: string;
}

interface FetchResult<T> {
  ok: boolean;
  status?: number;
  data?: T;
  error?: string;
}

function resolveTokenListNotice(
  status: number | null,
  t: Awaited<ReturnType<typeof getTranslations>>
): string {
  if (typeof status === "number" && status >= 400 && status < 500) {
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

interface IssuancePageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

export default async function IssuancePage({ searchParams }: IssuancePageProps) {
  const [t, { userId, orgId }, resolvedSearchParams, assetProfilesEnabled] = await Promise.all([
    getTranslations(),
    auth(),
    searchParams ?? Promise.resolve(undefined),
    assetProfiles(),
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
    // Search/filter/sort/page live in the URL, so a shared or reloaded link renders
    // the same filtered page server-side that the client would have fetched.
    const listQuery = parseIssuanceListQuery(resolvedSearchParams);
    const apiBaseUrl = resolvePlaygroundApiBaseUrl();
    const apiClient = await trace.step("create_sdp_api_client", () =>
      createSdpApiClient(trace.childContext("dashboard.issuance.api"))
    );
    const [templatesResult, tokensPage, facets, apiKeysResult, signerWalletsResult] =
      await Promise.all([
        trace.step("fetch_templates", () => fetchTemplates(apiClient.request, t)),
        trace.step("fetch_tokens", () =>
          fetchIssuanceTokensPage(apiClient.request, listQuery, {
            untitledLabel: t("DashboardIssuance.management.untitledToken"),
          })
        ),
        // Facet counts drive the filter options and the "no assets yet" vs "no
        // matches" distinction, so they must not be narrowed by the active filters.
        trace.step("fetch_token_facets", () => fetchIssuanceTokenFacets(apiClient.request)),
        trace.step("fetch_active_api_keys", () => fetchActiveApiKeys(apiClient.request)),
        trace.step("fetch_signer_wallets", () =>
          fetchPaymentsWallets(apiClient.request, { view: "summary" })
        ),
      ]);

    const tokens = assetProfilesEnabled
      ? await trace.step("attach_asset_profiles", () =>
          attachIssuanceAssetProfiles(apiClient.request, tokensPage.tokens)
        )
      : tokensPage.tokens;
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
      total: tokensPage.total,
      page: tokensPage.page,
      pageSize: tokensPage.pageSize,
      templateCount: templatesResult.data?.length ?? 0,
      apiKeyCount: apiKeys.length,
      signerWalletCount: signerWalletsResult.data?.length ?? 0,
    });

    return (
      <IssuanceWorkspace
        assetProfilesEnabled={assetProfilesEnabled}
        initialQuery={listQuery}
        initialTokens={tokens}
        initialTotal={tokensPage.total}
        facets={facets}
        templates={templatesResult.data ?? []}
        apiKeys={apiKeys}
        signerWallets={signerWalletsResult.data ?? []}
        apiBaseUrl={apiBaseUrl}
        templatesError={templatesError}
        tokensNotice={tokensPage.error ? resolveTokenListNotice(tokensPage.status, t) : null}
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
