import { listMembers, type Member, readableApiError } from "@/app/members/actions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getTranslations } from "@/i18n/server";
import { InviteMemberForm } from "./invite-member-form";

type Translate = Awaited<ReturnType<typeof getTranslations>>;

function formatJoined(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function roleLabel(role: string, t: Translate): string {
  return role === "admin" ? t("Shared.members.roleAdmin") : t("Shared.members.roleMember");
}

export async function MembersSection() {
  const t = await getTranslations();

  let members: Member[] = [];
  let loadError: string | null = null;

  // A failed list must not take the invite form down with it — an admin whose
  // org list is erroring can still need to add someone.
  try {
    members = await listMembers();
  } catch (error) {
    loadError = readableApiError(error);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Shared.members.title")}</CardTitle>
        <CardDescription>{t("Shared.members.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <InviteMemberForm />

        {loadError ? (
          <div className="rounded-xl border border-destructive-border bg-destructive-bg px-3 py-2 text-destructive-strong text-sm">
            {t("Shared.members.loadFailed", { error: loadError })}
          </div>
        ) : members.length === 0 ? (
          <p className="text-secondary text-sm">{t("Shared.members.empty")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("Shared.members.columnMember")}</TableHead>
                <TableHead className="w-40">{t("Shared.members.columnRole")}</TableHead>
                <TableHead className="w-40">{t("Shared.members.columnJoined")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((member) => (
                <TableRow key={member.id}>
                  <TableCell className="min-w-0">
                    <span className="block truncate font-medium text-primary text-sm">
                      {member.user.name?.trim() || t("Shared.members.unnamed")}
                    </span>
                    <span className="block truncate text-muted text-xs">{member.user.email}</span>
                  </TableCell>
                  <TableCell className="text-secondary text-sm">
                    {roleLabel(member.role, t)}
                  </TableCell>
                  <TableCell className="text-secondary text-sm">
                    {formatJoined(member.createdAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
