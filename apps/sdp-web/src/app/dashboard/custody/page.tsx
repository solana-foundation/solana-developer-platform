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

type CustodyProvider =
  | "privy"
  | "local"
  | "fireblocks"
  | "coinbase_cdp"
  | "para"
  | "turnkey"
  | "dfns";

interface CustodyConfig {
  id: string;
  organizationId: string;
  projectId: string | null;
  provider: CustodyProvider;
  publicKey: string;
  defaultWalletId: string | null;
  status: "active" | "inactive";
  createdAt: string;
}

interface CustodyWallet {
  id: string;
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

async function getCustodyConfig(request: SdpApiClient["request"]): Promise<CustodyConfig | null> {
  const res = await request("/v1/wallets/config");
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SDP API request failed (${res.status}): ${body}`);
  }
  const json = (await res.json()) as { data: { config: CustodyConfig } };
  return json.data.config;
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
  config: CustodyConfig | null;
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

  const { config } = linkedData;

  if (!config) {
    return (
      <SectionEntry>
        <Card>
          <CardHeader>
            <CardTitle>Enable wallets</CardTitle>
            <CardDescription>
              Provision your first signing wallet to authorize API operations.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center justify-between gap-4">
            <div className="text-sm text-[rgba(28,28,29,0.72)]">
              This creates a master signing wallet for your organization. You can add more wallets
              later and choose which one signs by default.
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
          <CardTitle>Signing configuration</CardTitle>
          <CardDescription>Controls which wallet signs new API actions.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div className="grid gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[rgba(28,28,29,0.72)]">Provider</span>
              <span className="font-medium text-[#1c1c1d]">{config.provider}</span>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[rgba(28,28,29,0.72)]">Master address</span>
              <span className="font-mono text-xs text-[#1c1c1d]">{config.publicKey}</span>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[rgba(28,28,29,0.72)]">Default wallet</span>
              <span className="font-mono text-xs text-[#1c1c1d]">
                {config.defaultWalletId ?? "Not set"}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap gap-3">
            <Link href="/dashboard/wallets/switch">
              <Button variant="secondary">Change provider</Button>
            </Link>
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

  const { config, wallets } = linkedData;

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
                    <TableHead>Purpose</TableHead>
                    <TableHead>Public key</TableHead>
                    <TableHead>Wallet id</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {wallets.map((w) => {
                    const isDefault = config?.defaultWalletId === w.walletId;
                    return (
                      <TableRow key={w.id}>
                        <TableCell className="font-medium">{w.label ?? "Untitled"}</TableCell>
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
                            {!isDefault ? (
                              <form action={setDefaultCustodyWallet}>
                                <input type="hidden" name="walletId" value={w.walletId} />
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
  const configResultPromise = settle(getCustodyConfig(apiClient.request));
  const walletsResultPromise = settle(apiClient.fetch<{ wallets: CustodyWallet[] }>("/v1/wallets"));
  const linkedDataPromise: Promise<LinkedCustodyData | null> = onboardingPromise.then(
    async (onboarding) => {
      if (!onboarding.linked) {
        return null;
      }

      const [configResult, walletsResult] = await Promise.all([
        configResultPromise,
        walletsResultPromise,
      ]);

      if (!configResult.ok) {
        throw configResult.error;
      }

      if (!walletsResult.ok) {
        throw walletsResult.error;
      }

      return {
        config: configResult.value,
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
