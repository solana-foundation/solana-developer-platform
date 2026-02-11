import { DashboardHeader } from "@/components/dashboard-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { auth } from "@clerk/nextjs/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { switchCustodyProvider } from "../actions";

export default async function CustodySwitchPage() {
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
        <DashboardHeader title="Change provider" subtitle="Custody" backHref="/dashboard/custody" />

        <Card>
          <CardHeader>
            <CardTitle>Switch custody provider</CardTitle>
            <CardDescription>
              This updates which provider signs new API actions. It does not automatically rotate
              existing on-chain authorities.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              Safeguard: type <span className="font-mono text-foreground">SWITCH</span> to confirm.
            </div>

            <form action={switchCustodyProvider} className="grid gap-5">
              <div className="grid gap-2">
                <Label htmlFor="provider">New provider</Label>
                <select
                  id="provider"
                  name="provider"
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
                  defaultValue="privy"
                >
                  <option value="privy">Privy</option>
                  <option value="local">Local (development only)</option>
                </select>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="walletLabel">Default wallet label</Label>
                <Input id="walletLabel" name="walletLabel" placeholder="Default" />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="confirm">Confirmation</Label>
                <Input id="confirm" name="confirm" placeholder="SWITCH" />
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit">Switch provider</Button>
                <Link href="/dashboard/custody">
                  <Button type="button" variant="secondary">
                    Cancel
                  </Button>
                </Link>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
