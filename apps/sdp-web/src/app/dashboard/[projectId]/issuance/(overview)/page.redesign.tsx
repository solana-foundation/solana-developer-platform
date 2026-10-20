import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { z } from "zod";
import { parseIssuanceListQuery } from "@/app/dashboard/[projectId]/issuance/issuance-list-query";
import {
  fetchIssuanceTokenFacets,
  fetchIssuanceTokensPage,
} from "@/app/dashboard/[projectId]/issuance/issuance-tokens.data";
import { IssuanceWorkspace } from "@/app/dashboard/[projectId]/issuance/issuance-workspace.redesign";
import {
  fetchActiveApiKeys,
  resolvePlaygroundApiBaseUrl,
} from "@/app/dashboard/[projectId]/playground-api-data";
import { getTranslations } from "@/i18n/server";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { createTimedTrace } from "@/lib/request-tracing";
import { createSdpApiClient, type SdpApiClient } from "@/lib/sdp-api";

const templatesResponseSchema = z.object({
  data: z.object({
    templates: z.array(
      z.object({ id: z.string(), name: z.string(), description: z.string().optional() })
    ),
  }),
});
type IssuanceTemplateView = z.infer<typeof templatesResponseSchema>["data"]["templates"][number];

/**
 * The token templates the playground's create examples offer. A failed read, or a response that
 * is not a list of templates, comes back as `failed` with none, and the playground says so.
 */
async function fetchTemplates(
  request: SdpApiClient["request"]
): Promise<{ templates: IssuanceTemplateView[]; failed: boolean }> {
  try {
    const response = await request("/v1/issuance/templates");
    if (!response.ok) return { templates: [], failed: true };
    const parsed = templatesResponseSchema.safeParse(await response.json());
    return parsed.success
      ? { templates: parsed.data.data.templates, failed: false }
      : { templates: [], failed: true };
  } catch {
    return { templates: [], failed: true };
  }
}

interface IssuancePageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Issuance on the new design: the project's tokens, searched, filtered, sorted and paged on
 * the server from the URL, and the API Playground's data beside them.
 */
export async function IssuancePage({ searchParams }: IssuancePageProps) {
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
  const listQuery = parseIssuanceListQuery(resolvedSearchParams);
  const apiClient = await trace.step("create_sdp_api_client", () =>
    createSdpApiClient(trace.childContext("dashboard.issuance.api"))
  );
  const [templatesResult, tokensPage, facets, apiKeysResult] = await Promise.all([
    trace.step("fetch_templates", () => fetchTemplates(apiClient.request)),
    trace.step("fetch_tokens", () =>
      fetchIssuanceTokensPage(apiClient.request, listQuery, {
        untitledLabel: t("DashboardIssuance.management.untitledToken"),
      })
    ),
    trace.step("fetch_token_facets", () => fetchIssuanceTokenFacets(apiClient.request)),
    trace.step("fetch_active_api_keys", () => fetchActiveApiKeys(apiClient.request)),
  ]);
  trace.log({
    ok: true,
    tokenCount: tokensPage.tokens.length,
    total: tokensPage.total,
    page: tokensPage.page,
  });

  return (
    <IssuanceWorkspace
      initialQuery={listQuery}
      initialTokens={tokensPage.tokens}
      initialTotal={tokensPage.total}
      facets={facets}
      templates={templatesResult.templates}
      templatesError={
        templatesResult.failed ? t("DashboardIssuance.errors.unableToLoadTemplates") : null
      }
      apiKeys={apiKeysResult.data ?? []}
      apiBaseUrl={resolvePlaygroundApiBaseUrl()}
      tokensNotice={tokensPage.error ? t("DashboardIssuance.errors.tokenListRetry") : null}
    />
  );
}
