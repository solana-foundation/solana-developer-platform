import Link from "next/link";
import { redirect } from "next/navigation";
import { OrganizationSwitcher } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getOnboardingStatus, linkOrganization } from "../onboarding/actions";
import { linkOrganizationInApi } from "@/lib/onboarding";

export default async function DashboardPage() {
  const { userId, orgId } = await auth();

  if (!userId) {
    redirect("/");
  }

  if (!orgId) {
    return (
      <main className="min-h-screen bg-background px-6 py-10 text-foreground">
        <div className="mx-auto flex max-w-3xl flex-col gap-6">
          <div>
            <p className="text-sm uppercase tracking-wide text-muted-foreground">Dashboard</p>
            <h1 className="text-2xl font-semibold">Select an organization</h1>
          </div>
          <Card>
            <CardHeader>
              <CardTitle>Choose an organization</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p>You need an organization to continue.</p>
              <OrganizationSwitcher hidePersonal />
            </CardContent>
          </Card>
        </div>
      </main>
    );
  }

  let onboarding = await getOnboardingStatus();

  if (!onboarding.linked) {
    try {
      await linkOrganizationInApi();
      onboarding = await getOnboardingStatus();
    } catch {
      // Ignore auto-link errors and fall back to manual retry UI.
    }
  }

  if (!onboarding.linked) {
    return (
      <main className="min-h-screen bg-background px-6 py-10 text-foreground">
        <div className="mx-auto flex max-w-3xl flex-col gap-6">
          <div>
            <p className="text-sm uppercase tracking-wide text-muted-foreground">Dashboard</p>
            <h1 className="text-2xl font-semibold">Finishing setup</h1>
          </div>
          <Card>
            <CardHeader>
              <CardTitle>Preparing your workspace</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm text-muted-foreground">
              <p>We are preparing your workspace. If this takes longer than a few seconds, try again.</p>
              <form action={linkOrganization}>
                <input type="hidden" name="returnTo" value="/dashboard" />
                <Button type="submit">Retry setup</Button>
              </form>
            </CardContent>
          </Card>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-background px-6 py-10 text-foreground">
      <div className="mx-auto flex max-w-5xl flex-col gap-8">
        <div>
          <p className="text-sm uppercase tracking-wide text-muted-foreground">Dashboard</p>
          <h1 className="text-2xl font-semibold">Welcome to SDP</h1>
        </div>

        <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
          <Card>
            <CardHeader>
              <CardTitle>Organization access</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm text-muted-foreground">
              <p>
                Manage who can sign up and invite teammates to your organization.
              </p>
              <div className="flex flex-wrap gap-3">
                <Button asChild>
                  <Link href="/allowlist">Manage allowlist</Link>
                </Button>
                <Button asChild variant="secondary">
                  <Link href="/members">Invite members</Link>
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>API keys</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm text-muted-foreground">
              <p>Create API keys from the console when you are ready to integrate.</p>
              <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                Endpoint: <span className="text-foreground">/v1/api-keys</span>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </main>
  );
}
