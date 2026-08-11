import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import type { OnboardingStatusResponse } from "@/app/dashboard/onboarding-status";
import {
  fetchActiveApiKeys,
  resolvePlaygroundApiBaseUrl,
} from "@/app/dashboard/playground-api-data";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { fetchProviderAvailability } from "@/lib/provider-availability";
import { createRequestScopedSdpApiClients } from "@/lib/sdp-api";
import { EarnDepositWizard } from "./earn-deposit-wizard";
import type { EarnApiKeyView } from "./integration-screen";

export const dynamic = "force-dynamic";

interface EarnDepositPageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

function firstParam(
  searchParams: Record<string, string | string[] | undefined> | undefined,
  key: string
): string | undefined {
  const value = searchParams?.[key];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Server shell for the deposit flow. Three things are resolved here rather than
 * client-side because they decide what the flow offers:
 *
 * - **Active API keys** gate the conditional integration screen. SDP persists no
 *   organization type, so "does this org hold API keys" is the honest available
 *   signal for an API-integrating (B2B2C) customer. Only id/name/prefix/
 *   environment cross the boundary — secrets are reveal-once at creation and are
 *   never readable again, by design.
 * - **The API base URL** so integration snippets name the real host.
 * - **Fireblocks entitlement**, because it is NOT enabled for an organization by
 *   default; without this the wallet step would offer a connect action that
 *   dead-ends.
 *
 * All three degrade to "off": a failure hides the integration screen or the
 * connect affordance, never the deposit flow itself.
 */
export default async function EarnDepositPage({ searchParams }: EarnDepositPageProps) {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const resolved = searchParams ? await searchParams : undefined;
  const initialStrategyId = firstParam(resolved, "strategy");

  let apiKeys: EarnApiKeyView[] = [];
  let fireblocksEnabled = false;

  try {
    const { organizationClient, projectClient } = await createRequestScopedSdpApiClients();
    if (projectClient) {
      // Provider access is keyed by the SDP organization id, which is not the
      // Clerk org id — it comes from the onboarding link, same as custody setup.
      const onboarding =
        await organizationClient.fetch<OnboardingStatusResponse>("/v1/onboarding/status");
      const [keysResult, availability] = await Promise.all([
        fetchActiveApiKeys(projectClient.request),
        onboarding.organization
          ? fetchProviderAvailability(projectClient.request, onboarding.organization.id).catch(
              () => undefined
            )
          : Promise.resolve(undefined),
      ]);
      if (keysResult.ok && keysResult.data) {
        apiKeys = keysResult.data.map((apiKey) => ({
          id: apiKey.id,
          name: apiKey.name,
          keyPrefix: apiKey.keyPrefix,
          environment: apiKey.environment,
        }));
      }
      fireblocksEnabled = availability?.enabledCustodyProviders.includes("fireblocks") ?? false;
    }
  } catch {
    // Optional context only — the flow still works without either signal.
  }

  return (
    <EarnDepositWizard
      apiBaseUrl={resolvePlaygroundApiBaseUrl()}
      apiKeys={apiKeys}
      fireblocksEnabled={fireblocksEnabled}
      initialStrategyId={initialStrategyId}
    />
  );
}
