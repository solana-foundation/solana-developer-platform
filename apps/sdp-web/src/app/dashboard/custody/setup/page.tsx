import { DashboardHeader } from "@/components/dashboard-header";
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
    <main className="min-h-screen bg-background px-6 py-10 text-foreground">
      <div className="mx-auto flex max-w-3xl flex-col gap-8">
        <DashboardHeader title="Enable custody" subtitle="Custody" backHref="/dashboard/custody" />

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
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
                  defaultValue="privy"
                >
                  <option value="privy">Privy (recommended)</option>
                  <option value="local">Local (development only)</option>
                </select>
                <p className="text-xs text-muted-foreground">
                  Privy is managed by SDP. Local custody generates a key stored in the database and
                  should not be used in production.
                </p>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="walletLabel">Wallet label</Label>
                <Input id="walletLabel" name="walletLabel" placeholder="Master wallet" />
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit">Provision wallet</Button>
                <Link href="/dashboard/custody">
                  <Button type="button" variant="secondary">
                    Cancel
                  </Button>
                </Link>
              </div>
            </form>

            <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              This step provisions custody for your organization. It does not automatically rotate
              on-chain authorities for existing assets.
            </div>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
