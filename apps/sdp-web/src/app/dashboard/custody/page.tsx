import { linkOrganization } from "@/app/onboarding/actions";
import { DashboardHeader } from "@/components/dashboard-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { sdpApiFetch, sdpApiRequest } from "@/lib/sdp-api";
import { auth, clerkClient } from "@clerk/nextjs/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createCustodyWallet, setDefaultCustodyWallet } from "./actions";

type CustodyProvider = "privy" | "local" | "fireblocks";

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

async function getCustodyConfig(): Promise<CustodyConfig | null> {
  const res = await sdpApiRequest("/v1/custody/config");
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

export default async function CustodyPage() {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect("/sign-in");
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const onboarding = await sdpApiFetch<{ linked: boolean }>("/v1/onboarding/status");
  if (!onboarding.linked) {
    const organization = await getClerkOrganizationSummary(orgId);

    return (
      <div className="mx-auto flex max-w-5xl flex-col gap-8">
        <DashboardHeader title="Wallets" />
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
      </div>
    );
  }

  const [config, walletsResp] = await Promise.all([
    getCustodyConfig(),
    sdpApiFetch<{ wallets: CustodyWallet[] }>("/v1/custody/wallets"),
  ]);
  const wallets = walletsResp.wallets;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8">
      <DashboardHeader title="Wallets" />

      {!config ? (
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
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
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

          <Card>
            <CardHeader>
              <CardTitle>New wallet</CardTitle>
              <CardDescription>Create an additional signing wallet.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {config.provider !== "privy" ? (
                <p className="text-sm text-[rgba(28,28,29,0.72)]">
                  Wallet provisioning is only available for the Privy provider right now.
                </p>
              ) : (
                <form action={createCustodyWallet} className="grid gap-4">
                  <div className="grid gap-2">
                    <Label htmlFor="label">Label</Label>
                    <Input id="label" name="label" placeholder="Signing wallet" />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="purpose">Purpose (optional)</Label>
                    <select
                      id="purpose"
                      name="purpose"
                      className="h-10 w-full rounded-lg border border-[rgba(28,28,29,0.16)] bg-white px-3 text-sm text-[#1c1c1d]"
                      defaultValue=""
                    >
                      <option value="">Not set</option>
                      <option value="root">root</option>
                      <option value="mint_authority">mint_authority</option>
                      <option value="freeze_authority">freeze_authority</option>
                      <option value="fee_payer">fee_payer</option>
                      <option value="transfer">transfer</option>
                    </select>
                    <p className="text-xs text-[rgba(28,28,29,0.64)]">
                      Purposes are used for future policy and UI grouping.
                    </p>
                  </div>
                  <label className="flex items-center gap-2 text-sm text-[rgba(28,28,29,0.72)]">
                    <input type="checkbox" name="setDefault" />
                    Make default
                  </label>
                  <Button type="submit">Create wallet</Button>
                </form>
              )}
            </CardContent>
          </Card>
        </div>
      )}

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
                    <TableHead className="text-right">Default</TableHead>
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
                          {w.walletId}
                        </TableCell>
                        <TableCell className="text-right">
                          {isDefault ? (
                            <span className="text-xs font-medium text-[#1c1c1d]">Default</span>
                          ) : (
                            <form action={setDefaultCustodyWallet}>
                              <input type="hidden" name="walletId" value={w.walletId} />
                              <Button type="submit" size="sm" variant="secondary">
                                Set
                              </Button>
                            </form>
                          )}
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
    </div>
  );
}
