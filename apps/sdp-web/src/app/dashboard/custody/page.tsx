import {
  type KnownCustodyProvider,
  isKnownCustodyProvider,
} from "@/app/dashboard/custody/provider-catalog";
import {
  fetchActiveApiKeys,
  resolvePlaygroundApiBaseUrl,
} from "@/app/dashboard/playground-api-data";
import {
  WalletsOnboardingSkeleton,
  WalletsPageSkeleton,
} from "@/app/dashboard/wallets/wallets-page-skeleton";
import { linkOrganization } from "@/app/onboarding/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { type SdpApiClient, createSdpApiClient } from "@/lib/sdp-api";
import { auth, clerkClient } from "@clerk/nextjs/server";
import type { CustodyConfigSummary, CustodyWalletSummary } from "@sdp/types";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { WalletsWorkspace } from "./wallets-workspace";

interface ClerkOrganizationSummary {
  id: string;
  name: string | null;
  slug: string | null;
}

type SettledResult<T> = { ok: true; value: T } | { ok: false; error: unknown };

function settle<T>(promise: Promise<T>): Promise<SettledResult<T>> {
  return promise.then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error })
  );
}

async function getCustodyConfigs(
  request: SdpApiClient["request"]
): Promise<{ configs: CustodyConfigSummary[]; defaultConfigId: string | null }> {
  const res = await request("/v1/wallets/configs");
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SDP API request failed (${res.status}): ${body}`);
  }

  const json = (await res.json()) as {
    data: { configs: CustodyConfigSummary[]; defaultConfigId: string | null };
  };
  return json.data;
}

async function getCustodyWallets(
  request: SdpApiClient["request"]
): Promise<CustodyWalletSummary[]> {
  // biome-ignore lint/nursery/noSecrets: Public API path with query flags for wallet listing.
  const res = await request("/v1/wallets?includeAllProviders=true&includeBalances=true");
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SDP API request failed (${res.status}): ${body}`);
  }

  const json = (await res.json()) as {
    data?: { wallets?: CustodyWalletSummary[] };
  };
  return json.data?.wallets ?? [];
}

async function getClerkOrganizationSummary(
  organizationId: string
): Promise<ClerkOrganizationSummary> {
  try {
    const client = await clerkClient();
    const organization = await client.organizations.getOrganization({
      organizationId,
    });
    return {
      id: organization.id,
      name: organization.name ?? null,
      slug: organization.slug ?? null,
    };
  } catch {
    return {
      id: organizationId,
      name: null,
      slug: null,
    };
  }
}

async function OnboardingGateSection({ orgId }: { orgId: string }) {
  const organization = await getClerkOrganizationSummary(orgId);

  return (
    <Card className="rounded-[24px] border-[rgba(28,28,29,0.08)] shadow-none">
      <CardHeader>
        <CardTitle>Confirm organization details</CardTitle>
        <CardDescription>
          Link this Clerk organization in SDP before setting up wallet infrastructure.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-xl border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.04)] p-4 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2 py-1">
            <span className="text-[rgba(28,28,29,0.72)]">Organization name</span>
            <span className="font-medium text-[#1c1c1d]">{organization.name ?? "Unavailable"}</span>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 py-1">
            <span className="text-[rgba(28,28,29,0.72)]">Organization slug</span>
            <span className="font-mono text-xs text-[#1c1c1d]">
              {organization.slug ?? "Unavailable"}
            </span>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 py-1">
            <span className="text-[rgba(28,28,29,0.72)]">Clerk organization ID</span>
            <span className="font-mono text-xs text-[#1c1c1d]">{organization.id}</span>
          </div>
        </div>
        <p className="text-sm text-[rgba(28,28,29,0.72)]">
          Confirming will link this organization in SDP and unlock wallet creation.
        </p>
        <form action={linkOrganization}>
          <input type="hidden" name="returnTo" value="/dashboard/wallets" />
          <Button type="submit">Confirm and link organization</Button>
        </form>
      </CardContent>
    </Card>
  );
}

export default async function CustodyPage() {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect("/sign-in");
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const apiClient = await createSdpApiClient();
  const onboarding = await apiClient.fetch<{ linked: boolean }>("/v1/onboarding/status");

  if (!onboarding.linked) {
    return (
      <Suspense fallback={<WalletsOnboardingSkeleton />}>
        <OnboardingGateSection orgId={orgId} />
      </Suspense>
    );
  }

  const [configsResult, walletsResult, apiKeysResult] = await Promise.all([
    settle(getCustodyConfigs(apiClient.request)),
    settle(getCustodyWallets(apiClient.request)),
    fetchActiveApiKeys(apiClient.request),
  ]);

  const connectedProviders: KnownCustodyProvider[] = configsResult.ok
    ? configsResult.value.configs
        .filter((config) => config.status === "active")
        .map((config) => config.provider)
        .filter(isKnownCustodyProvider)
    : [];

  const configsError = configsResult.ok
    ? null
    : configsResult.error instanceof Error
      ? configsResult.error.message
      : "Unable to load wallet providers";
  const walletsError = walletsResult.ok
    ? null
    : walletsResult.error instanceof Error
      ? walletsResult.error.message
      : "Unable to load wallets";
  const apiKeys = apiKeysResult.ok ? (apiKeysResult.data ?? []) : [];

  return (
    <Suspense fallback={<WalletsPageSkeleton />}>
      <WalletsWorkspace
        apiBaseUrl={resolvePlaygroundApiBaseUrl()}
        apiKeys={apiKeys}
        connectedProviders={connectedProviders}
        configsError={configsError}
        wallets={walletsResult.ok ? walletsResult.value : []}
        walletsError={walletsError}
      />
    </Suspense>
  );
}
