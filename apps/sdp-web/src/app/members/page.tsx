import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { OrganizationSwitcher } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";

export default async function MembersPage() {
  const { orgId } = await auth();

  if (!orgId) {
    return (
      <main className="min-h-screen bg-background px-6 py-10 text-foreground">
        <div className="mx-auto flex max-w-3xl flex-col gap-6">
          <div>
            <p className="text-sm uppercase tracking-wide text-muted-foreground">Organization</p>
            <h1 className="text-2xl font-semibold">Invitations</h1>
          </div>
          <Card>
            <CardHeader>
              <CardTitle>Pick an organization</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p>You need an organization to invite members.</p>
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
          <p className="text-sm uppercase tracking-wide text-muted-foreground">Organization</p>
          <h1 className="text-2xl font-semibold">Invitations</h1>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Coming soon</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Member management will be available in a future update.
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Members</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Member lists will appear here once enabled.
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
