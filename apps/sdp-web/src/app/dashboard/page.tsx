import { redirect } from "next/navigation";
import { OrganizationSwitcher, UserButton } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

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

  return (
    <main className="min-h-screen bg-background px-6 py-10 text-foreground">
      <div className="mx-auto flex max-w-5xl flex-col gap-8">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-sm uppercase tracking-wide text-muted-foreground">Dashboard</p>
            <h1 className="text-2xl font-semibold">Welcome to SDP</h1>
          </div>
          <div className="flex items-center gap-3">
            <OrganizationSwitcher hidePersonal />
            <UserButton />
          </div>
        </header>

        <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
          <Card>
            <CardHeader>
              <CardTitle>Organization access</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm text-muted-foreground">
              <p>Organization management is being rolled out next.</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>API keys</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm text-muted-foreground">
              <p>API keys will be available once the console rollout is complete.</p>
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
