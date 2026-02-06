import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { OrganizationSwitcher } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";

export default async function AllowlistPage() {
  const { orgId } = await auth();

  if (!orgId) {
    return (
      <main className="min-h-screen bg-background px-6 py-10 text-foreground">
        <div className="mx-auto flex max-w-3xl flex-col gap-6">
          <div>
            <p className="text-sm uppercase tracking-wide text-muted-foreground">Access</p>
            <h1 className="text-2xl font-semibold">Allowlist</h1>
          </div>
          <Card>
            <CardHeader>
              <CardTitle>Pick an organization</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p>You need an organization to manage the allowlist.</p>
              <OrganizationSwitcher hidePersonal />
            </CardContent>
          </Card>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-background px-6 py-10 text-foreground">
      <div className="mx-auto flex max-w-3xl flex-col gap-8">
        <div>
          <p className="text-sm uppercase tracking-wide text-muted-foreground">Access</p>
          <h1 className="text-2xl font-semibold">Allowlist</h1>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Coming soon</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Allowlist management will be available in a future update.
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
