import { SectionEntry } from "@/app/dashboard/wallets/section-entry";
import {
  WalletsSigningConfigSkeleton,
  WalletsTableSectionSkeleton,
} from "@/app/dashboard/wallets/wallets-page-skeleton";
import { linkOrganization } from "@/app/onboarding/actions";
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
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { setDefaultCustodyWallet } from "./actions";
import { WalletSignerCheckButton } from "./wallet-signer-check-button";

type CustodyProvider = "privy" | "local" | "fireblocks" | "coinbase_cdp" | "para" | "turnkey";

interface CustodyConfig {
  id: string;
  organizationId: string;
  projectId: string | null;
  provider: CustodyProvider;
  publicKey: string;
  defaultWalletId: string | null;
  status: "active" | "inactive";
  createdAt: string;
  isDefault?: boolean;
}

interface CustodyWallet {
  id: string;
  custodyConfigId?: string;
  provider?: CustodyProvider;
  isDefaultProvider?: boolean;
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

function formatProviderName(provider: CustodyProvider): string {
  switch (provider) {
    case "coinbase_cdp":
      return "Coinbase CDP";
    case "fireblocks":
      return "Fireblocks";
    case "local":
      return "Local";
    case "para":
      return "Para";
    case "privy":
      return "Privy";
    case "turnkey":
      return "Turnkey";
    default:
      return provider;
  }
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
  defaultConfig: CustodyConfig | null;
  configs: CustodyConfig[];
  wallets: CustodyWallet[];
};

async function SigningConfigurationSection({
  linkedDataPromise,
}: {
  linkedDataPromise: Promise<LinkedCustodyData | null>;
}) {
  const linkedData = await linkedDataPromise;
  if (!linkedData) {
    return null;
  }

  const { defaultConfig, configs } = linkedData;

  if (!defaultConfig) {
    return (
      <SectionEntry>
        <Card>
          <CardHeader>
            <CardTitle>Enable wallets</CardTitle>
            <CardDescription>
              Create your first signing provider and wallet to authorize API operations.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center justify-between gap-4">
            <div className="text-sm text-[rgba(28,28,29,0.72)]">
              You can connect multiple providers over time and set which one signs by default.
            </div>
            <Link href="/dashboard/wallets/setup">
              <Button>Get started</Button>
            </Link>
          </CardContent>
        </Card>
      </SectionEntry>
    );
  }

  return (
    <SectionEntry delay={0.02}>
      <Card>
        <CardHeader>
          <CardTitle>Default signing provider</CardTitle>
          <CardDescription>Controls which provider signs new API actions by default.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div className="grid gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[rgba(28,28,29,0.72)]">Provider</span>
              <span className="font-medium text-[#1c1c1d]">
                {formatProviderName(defaultConfig.provider)}
              </span>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[rgba(28,28,29,0.72)]">Master address</span>
              <span className="font-mono text-xs text-[#1c1c1d]">{defaultConfig.publicKey}</span>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[rgba(28,28,29,0.72)]">Default wallet</span>
              <span className="font-mono text-xs text-[#1c1c1d]">
                {defaultConfig.defaultWalletId ?? "Not set"}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap gap-3">
            <Link href="/dashboard/wallets/switch">
              <Button variant="secondary">Set default / Connect provider</Button>
            </Link>
          </div>

          <div className="space-y-2 rounded-xl border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.03)] p-3">
            <p className="text-xs font-medium text-[rgba(28,28,29,0.8)]">Connected providers</p>
            {configs.length === 0 ? (
              <p className="text-xs text-[rgba(28,28,29,0.64)]">No providers connected yet.</p>
            ) : (
              <div className="grid gap-2">
                {configs.map((config) => (
                  <div
                    key={config.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[rgba(28,28,29,0.1)] px-2 py-1.5"
                  >
                    <span className="font-medium text-[#1c1c1d]">
                      {formatProviderName(config.provider)}
                    </span>
                    <div className="flex items-center gap-2">
                      {config.isDefault ? (
                        <span className="rounded-full bg-[rgba(28,28,29,0.12)] px-2 py-0.5 text-[11px] font-medium text-[#1c1c1d]">
                          Default
                        </span>
                      ) : null}
                      <span className="font-mono text-[11px] text-[rgba(28,28,29,0.72)]">
                        {config.defaultWalletId ?? "No default wallet"}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-xl border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.04)] px-3 py-2 text-xs text-[rgba(28,28,29,0.64)]">
            Changing providers affects new actions only. Existing on-chain authorities are not
            automatically rotated.
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

  const { defaultConfig, wallets } = linkedData;

  return (
    <SectionEntry delay={0.08}>
      <Card>
        <CardHeader>
          <CardTitle>Wallets</CardTitle>
          <CardDescription>Signing wallets available to your organization.</CardDescription>
        </CardHeader>
        <CardContent>
          {wallets.length === 0 ? (
            <p className="text-sm text-[rgba(28,28,29,0.72)]">No wallets found.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Label</TableHead>
                    <TableHead>Provider</TableHead>
                    <TableHead>Purpose</TableHead>
                    <TableHead>Public key</TableHead>
                    <TableHead>Wallet id</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {wallets.map((w) => {
                    const provider = w.provider ?? defaultConfig?.provider ?? "privy";
                    const isDefaultProvider = w.isDefaultProvider === true;
                    const isDefaultWallet =
                      isDefaultProvider && defaultConfig?.defaultWalletId === w.walletId;
                    return (
                      <TableRow key={w.id}>
                        <TableCell className="font-medium">{w.label ?? "Untitled"}</TableCell>
                        <TableCell className="text-[rgba(28,28,29,0.72)]">
                          <div className="inline-flex items-center gap-2">
                            <span>{formatProviderName(provider)}</span>
                            {isDefaultProvider ? (
                              <span className="rounded-full bg-[rgba(28,28,29,0.12)] px-2 py-0.5 text-[11px] font-medium text-[#1c1c1d]">
                                Default provider
                              </span>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell className="text-[rgba(28,28,29,0.72)]">
                          {w.purpose ?? "-"}
                        </TableCell>
                        <TableCell className="font-mono text-xs">{w.publicKey}</TableCell>
                        <TableCell className="font-mono text-xs text-[rgba(28,28,29,0.72)]">
                          <div
                            className="max-w-[10rem] truncate sm:max-w-[14rem]"
                            title={w.walletId}
                          >
                            {w.walletId}
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="inline-flex items-center justify-end gap-2">
                            {isDefaultProvider && !isDefaultWallet ? (
                              <form action={setDefaultCustodyWallet}>
                                <input type="hidden" name="walletId" value={w.walletId} />
                                <input type="hidden" name="provider" value={provider} />
                                <Button type="submit" size="sm" variant="secondary">
                                  Set
                                </Button>
                              </form>
                            ) : null}
                            <WalletSignerCheckButton walletId={w.walletId} />
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </SectionEntry>
  );
}

async function PrimaryWalletSection({
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

  return <SigningConfigurationSection linkedDataPromise={linkedDataPromise} />;
}

export default async function CustodyPage() {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect("/sign-in");
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const pageContainerClassName = "w-full max-w-5xl flex flex-col gap-6";
  const apiClient = await createSdpApiClient();
  const onboardingPromise = apiClient.fetch<{ linked: boolean }>("/v1/onboarding/status");
  const configsResultPromise = settle(getCustodyConfigs(apiClient.request));
  const walletsResultPromise = settle(
    apiClient.fetch<{ wallets: CustodyWallet[] }>("/v1/wallets?includeAllProviders=true")
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

      const defaultConfig =
        configsResult.value.configs.find(
          (config) => config.id === configsResult.value.defaultConfigId
        ) ?? null;

      return {
        defaultConfig,
        configs: configsResult.value.configs,
        wallets: walletsResult.value.wallets,
      };
    }
  );

  return (
    <div className={pageContainerClassName}>
      <Suspense fallback={<WalletsSigningConfigSkeleton />}>
        <PrimaryWalletSection
          orgId={orgId}
          onboardingPromise={onboardingPromise}
          linkedDataPromise={linkedDataPromise}
        />
      </Suspense>
      <Suspense fallback={<WalletsTableSectionSkeleton />}>
        <WalletsSection linkedDataPromise={linkedDataPromise} />
      </Suspense>
    </div>
  );
}
