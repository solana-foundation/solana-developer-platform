import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { auth } from "@clerk/nextjs/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { initializeCustody } from "../actions";

export default async function CustodySetupPage() {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect("/sign-in");
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  return (
    <div className="w-full max-w-3xl flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Create your master signing wallet</CardTitle>
          <CardDescription>
            This wallet will be used to sign API operations by default. You can create additional
            wallets later.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <form action={initializeCustody} className="grid gap-5">
            <div className="grid gap-2">
              <Label htmlFor="provider">Provider</Label>
              <select
                id="provider"
                name="provider"
                className="h-10 w-full rounded-lg border border-[rgba(28,28,29,0.16)] bg-white px-3 text-sm text-[#1c1c1d]"
                defaultValue="privy"
              >
                <option value="privy">Privy (recommended)</option>
                <option value="fireblocks">Fireblocks</option>
                <option value="coinbase_cdp">Coinbase CDP</option>
                <option value="para">Para</option>
                <option value="turnkey">Turnkey</option>
                <option value="local">Local (development only)</option>
              </select>
              <p className="text-xs text-[rgba(28,28,29,0.64)]">
                Fireblocks, Privy, Coinbase CDP, Para, and Turnkey are supported custody providers.
                Local provider mode generates a key stored in the database and should not be used in
                production.
              </p>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="walletLabel">Wallet label</Label>
              <Input id="walletLabel" name="walletLabel" placeholder="Master wallet" />
            </div>

            <div className="grid gap-4 rounded-xl border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.03)] p-4">
              <div className="space-y-1">
                <p className="text-sm font-medium text-[#1c1c1d]">Fireblocks credentials</p>
                <p className="text-xs text-[rgba(28,28,29,0.64)]">
                  Required only when provider is Fireblocks. Ignored for other providers.
                </p>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="apiKey">API key</Label>
                <Input id="apiKey" name="apiKey" placeholder="Fireblocks API key" />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="apiSecretPem">API secret PEM</Label>
                <textarea
                  id="apiSecretPem"
                  name="apiSecretPem"
                  className="min-h-28 w-full rounded-lg border border-[rgba(28,28,29,0.16)] bg-white px-3 py-2 text-sm text-[#1c1c1d]"
                  placeholder="-----BEGIN PRIVATE KEY-----"
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="vaultAccountId">Vault account ID</Label>
                <Input id="vaultAccountId" name="vaultAccountId" placeholder="Vault account ID" />
              </div>

              <div className="grid gap-2 md:grid-cols-2 md:gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="assetId">Asset ID (optional)</Label>
                  <Input id="assetId" name="assetId" placeholder="SOL" />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="apiBaseUrl">API base URL (optional)</Label>
                  <Input
                    id="apiBaseUrl"
                    name="apiBaseUrl"
                    placeholder="https://api.fireblocks.io"
                  />
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit">Provision wallet</Button>
              <Link href="/dashboard/wallets">
                <Button type="button" variant="secondary">
                  Cancel
                </Button>
              </Link>
            </div>
          </form>

          <div className="rounded-xl border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.04)] px-3 py-2 text-xs text-[rgba(28,28,29,0.64)]">
            This step provisions wallet signing for your organization. It does not automatically
            rotate on-chain authorities for existing assets.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
