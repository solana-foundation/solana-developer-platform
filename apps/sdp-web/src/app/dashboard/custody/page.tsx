import {
  CUSTODY_FEATURES,
  CUSTODY_PROVIDER_CATALOG,
  formatCustodyProviderName,
  isKnownCustodyProvider,
} from "@/app/dashboard/custody/provider-catalog";
import { SectionEntry } from "@/app/dashboard/wallets/section-entry";
import {
  WalletsSigningConfigSkeleton,
  WalletsTableSectionSkeleton,
} from "@/app/dashboard/wallets/wallets-page-skeleton";
import { linkOrganization } from "@/app/onboarding/actions";
import { PageBody, PageHeader, PageLayout } from "@/components/layouts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { type SdpApiClient, createSdpApiClient } from "@/lib/sdp-api";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { CheckCircle2 } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { WalletActionsMenu } from "./wallet-actions-menu";
import { WalletAddressCopyButton } from "./wallet-address-copy-button";
import { WalletLabelInlineEditor } from "./wallet-label-inline-editor";

interface CustodyConfig {
  id: string;
  organizationId: string;
  projectId: string | null;
  provider: string;
  publicKey: string;
  defaultWalletId: string | null;
  status: "active" | "inactive";
  createdAt: string;
}

interface CustodyWallet {
  id: string;
  custodyConfigId?: string;
  provider?: string;
  walletId: string;
  publicKey: string;
  label: string | null;
  purpose: string | null;
  status: "active" | "inactive";
  createdAt: string;
}

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
): Promise<{ configs: CustodyConfig[]; defaultConfigId: string | null }> {
  const res = await request("/v1/wallets/configs");
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SDP API request failed (${res.status}): ${body}`);
  }
  const json = (await res.json()) as {
    data: { configs: CustodyConfig[]; defaultConfigId: string | null };
  };
  return json.data;
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

async function OnboardingGateSection({
  orgId,
  onboardingPromise,
}: {
  orgId: string;
  onboardingPromise: Promise<{ linked: boolean }>;
}) {
  const onboarding = await onboardingPromise;
  if (onboarding.linked) {
    return null;
  }

  const organization = await getClerkOrganizationSummary(orgId);

  return (
    <SectionEntry>
      <Card>
        <CardHeader>
          <CardTitle>Confirm organization details</CardTitle>
          <CardDescription>
            Review the Clerk organization details below before linking it in SDP.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-xl border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.04)] p-4 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2 py-1">
              <span className="text-[rgba(28,28,29,0.72)]">Organization name</span>
              <span className="font-medium text-[#1c1c1d]">
                {organization.name ?? "Unavailable"}
              </span>
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
            Confirming will link this Clerk organization in SDP (D1) and enable wallet setup.
          </p>
          <form action={linkOrganization}>
            <input type="hidden" name="returnTo" value="/dashboard/wallets" />
            <Button type="submit">Confirm and link organization</Button>
          </form>
        </CardContent>
      </Card>
    </SectionEntry>
  );
}

type LinkedCustodyData = {
  configs: CustodyConfig[];
  wallets: CustodyWallet[];
};

async function ProvidersSection({
  linkedDataPromise,
}: {
  linkedDataPromise: Promise<LinkedCustodyData | null>;
}) {
  const linkedData = await linkedDataPromise;
  if (!linkedData) {
    return null;
  }

  if (linkedData.wallets.length > 0) {
    return null;
  }

  const connectedProviderSet = new Set(
    linkedData.configs.map((config) => config.provider).filter(isKnownCustodyProvider)
  );

  const connectedCount = connectedProviderSet.size;

  return (
    <SectionEntry delay={0.02}>
      <Card>
        <CardHeader>
          <CardTitle>Custody providers</CardTitle>
          <CardDescription>
            Activate providers and create their first wallet directly from this page.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-sm text-[rgba(28,28,29,0.72)]">
            {connectedCount === 0
              ? "No providers are activated yet."
              : `${connectedCount} provider${connectedCount === 1 ? "" : "s"} activated.`}
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {CUSTODY_PROVIDER_CATALOG.map((provider) => {
              const isActive = connectedProviderSet.has(provider.id);
              return (
                <div
                  key={provider.id}
                  className={[
                    "rounded-xl border p-4",
                    isActive
                      ? "border-[rgba(28,28,29,0.16)] bg-[rgba(28,28,29,0.06)]"
                      : "border-[rgba(28,28,29,0.12)] bg-white",
                  ].join(" ")}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold text-[#1c1c1d]">{provider.label}</p>
                      <p className="mt-1 text-xs text-[rgba(28,28,29,0.64)]">
                        {provider.description}
                      </p>
                    </div>
                    {isActive ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-[rgba(28,28,29,0.12)] px-2 py-0.5 text-[11px] font-medium text-[#1c1c1d]">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        Activated
                      </span>
                    ) : null}
                  </div>

                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {CUSTODY_FEATURES.map((feature) => (
                      <span
                        key={feature}
                        className="rounded-full border border-[rgba(28,28,29,0.16)] bg-[rgba(28,28,29,0.04)] px-2 py-0.5 text-[11px] text-[rgba(28,28,29,0.78)]"
                      >
                        {feature}
                      </span>
                    ))}
                  </div>

                  <div className="mt-4">
                    {isActive ? (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled
                        className="w-full"
                      >
                        Activated
                      </Button>
                    ) : (
                      <Link href={`/dashboard/wallets/setup?provider=${provider.id}`}>
                        <Button type="button" size="sm" className="w-full">
                          Activate provider
                        </Button>
                      </Link>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </SectionEntry>
  );
}

async function WalletsSection({
  linkedDataPromise,
}: {
  linkedDataPromise: Promise<LinkedCustodyData | null>;
}) {
  const linkedData = await linkedDataPromise;
  if (!linkedData) {
    return null;
  }

  const { configs, wallets } = linkedData;

  return (
    <SectionEntry delay={0.08}>
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <CardTitle>Wallets</CardTitle>
            <CardDescription>Signing wallets available to your organization.</CardDescription>
          </div>
          <Link href="/dashboard/wallets/setup">
            <Button type="button" size="sm" className="shrink-0">
              New wallet
            </Button>
          </Link>
        </CardHeader>
        <CardContent>
          {wallets.length === 0 ? (
            <p className="text-sm text-[rgba(28,28,29,0.72)]">
              {configs.length === 0
                ? "Activate a provider to create your first wallet."
                : "No wallets found yet for the connected providers."}
            </p>
          ) : (
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[22%]">Label</TableHead>
                  <TableHead className="w-[10%]">Provider</TableHead>
                  <TableHead className="w-[8%]">Purpose</TableHead>
                  <TableHead className="w-[24%]">Public key</TableHead>
                  <TableHead className="w-[24%]">Wallet id</TableHead>
                  <TableHead className="w-[12%] text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {wallets.map((wallet) => (
                  <TableRow key={wallet.id}>
                    <TableCell className="font-medium">
                      <WalletLabelInlineEditor walletId={wallet.walletId} label={wallet.label} />
                    </TableCell>
                    <TableCell className="text-[rgba(28,28,29,0.72)]">
                      <div
                        className="truncate"
                        title={formatCustodyProviderName(wallet.provider ?? "unknown")}
                      >
                        {formatCustodyProviderName(wallet.provider ?? "unknown")}
                      </div>
                    </TableCell>
                    <TableCell className="text-[rgba(28,28,29,0.72)]">
                      {wallet.purpose ?? "-"}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      <div className="flex items-center gap-1.5">
                        <div className="block min-w-0 truncate" title={wallet.publicKey}>
                          {wallet.publicKey}
                        </div>
                        <WalletAddressCopyButton address={wallet.publicKey} />
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-[rgba(28,28,29,0.72)]">
                      <div className="block truncate" title={wallet.walletId}>
                        {wallet.walletId}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="inline-flex items-center justify-end">
                        <WalletActionsMenu
                          walletAddress={wallet.publicKey}
                          walletId={wallet.walletId}
                          walletLabel={wallet.label}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </SectionEntry>
  );
}

async function PrimarySection({
  orgId,
  onboardingPromise,
  linkedDataPromise,
}: {
  orgId: string;
  onboardingPromise: Promise<{ linked: boolean }>;
  linkedDataPromise: Promise<LinkedCustodyData | null>;
}) {
  const onboarding = await onboardingPromise;

  if (!onboarding.linked) {
    return <OnboardingGateSection orgId={orgId} onboardingPromise={Promise.resolve(onboarding)} />;
  }

  return <ProvidersSection linkedDataPromise={linkedDataPromise} />;
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
  const onboardingPromise = apiClient.fetch<{ linked: boolean }>("/v1/onboarding/status");
  const configsResultPromise = settle(getCustodyConfigs(apiClient.request));
  const walletsQuery = new URLSearchParams({ includeAllProviders: "true" }).toString();
  const walletsResultPromise = settle(
    apiClient.fetch<{ wallets: CustodyWallet[] }>(`/v1/wallets?${walletsQuery}`)
  );

  const linkedDataPromise: Promise<LinkedCustodyData | null> = onboardingPromise.then(
    async (onboarding) => {
      if (!onboarding.linked) {
        return null;
      }

      const [configsResult, walletsResult] = await Promise.all([
        configsResultPromise,
        walletsResultPromise,
      ]);

      if (!configsResult.ok) {
        throw configsResult.error;
      }

      if (!walletsResult.ok) {
        throw walletsResult.error;
      }

      return {
        configs: configsResult.value.configs,
        wallets: walletsResult.value.wallets,
      };
    }
  );

  return (
    <PageLayout width="full">
      <PageHeader variant="wide" title="Wallets" />
      <PageBody>
        <div className="w-full flex flex-col gap-6">
          <Suspense fallback={<WalletsSigningConfigSkeleton />}>
            <PrimarySection
              orgId={orgId}
              onboardingPromise={onboardingPromise}
              linkedDataPromise={linkedDataPromise}
            />
          </Suspense>
          <Suspense fallback={<WalletsTableSectionSkeleton />}>
            <WalletsSection linkedDataPromise={linkedDataPromise} />
          </Suspense>
        </div>
      </PageBody>
    </PageLayout>
  );
}
