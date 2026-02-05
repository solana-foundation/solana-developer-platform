import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { addAllowlistEntry, listAllowlistEntries, removeAllowlistEntry } from "./actions";
import { auth } from "@clerk/nextjs/server";
import { OrganizationSwitcher } from "@clerk/nextjs";
import { getOnboardingStatus, linkOrganization } from "../onboarding/actions";

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
              <p>You need an active Clerk organization to manage the allowlist.</p>
              <OrganizationSwitcher hidePersonal />
            </CardContent>
          </Card>
        </div>
      </main>
    );
  }

  const onboarding = await getOnboardingStatus();

  if (!onboarding.linked) {
    return (
      <main className="min-h-screen bg-background px-6 py-10 text-foreground">
        <div className="mx-auto flex max-w-3xl flex-col gap-6">
          <div>
            <p className="text-sm uppercase tracking-wide text-muted-foreground">Access</p>
            <h1 className="text-2xl font-semibold">Allowlist</h1>
          </div>
          <Card>
            <CardHeader>
              <CardTitle>Get started</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p>Complete onboarding before managing the allowlist.</p>
              <form action={linkOrganization}>
                <input type="hidden" name="returnTo" value="/allowlist" />
                <Button type="submit">Get started</Button>
              </form>
            </CardContent>
          </Card>
        </div>
      </main>
    );
  }

  const entries = await listAllowlistEntries();

  return (
    <main className="min-h-screen bg-background px-6 py-10 text-foreground">
      <div className="mx-auto flex max-w-5xl flex-col gap-8">
        <div>
          <p className="text-sm uppercase tracking-wide text-muted-foreground">Access</p>
          <h1 className="text-2xl font-semibold">Allowlist</h1>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Add entry</CardTitle>
          </CardHeader>
          <CardContent>
            <form action={addAllowlistEntry} className="grid gap-4 md:grid-cols-[160px_1fr_120px]">
              <div className="space-y-2">
                <Label htmlFor="type">Type</Label>
                <Select name="type" defaultValue="email">
                  <SelectTrigger id="type">
                    <SelectValue placeholder="Select" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="email">Email</SelectItem>
                    <SelectItem value="domain">Domain</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="value">Email or domain</Label>
                <Input id="value" name="value" placeholder="example@company.com" required />
              </div>
              <div className="flex items-end">
                <Button type="submit" className="w-full">
                  Add
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Active allowlist</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Value</TableHead>
                  <TableHead>Added</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="text-muted-foreground">
                      No allowlist entries yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  entries.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="capitalize">{entry.type}</TableCell>
                      <TableCell>{entry.value}</TableCell>
                      <TableCell>{new Date(entry.createdAt).toLocaleDateString()}</TableCell>
                      <TableCell className="text-right">
                        <form action={removeAllowlistEntry}>
                          <input type="hidden" name="id" value={entry.id} />
                          <Button type="submit" variant="ghost" className="text-destructive">
                            Remove
                          </Button>
                        </form>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
