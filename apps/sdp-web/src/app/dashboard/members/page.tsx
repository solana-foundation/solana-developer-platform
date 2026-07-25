import { listMembers, type Member } from "@/app/members/actions";
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

export default async function DashboardMembersPage() {
  const t = await getTranslations();

  let members: Member[] = [];
  let loadError: string | null = null;

  // A failed member list must not take the invite form down with it — an admin
  // whose org list is erroring can still need to add someone.
  try {
    members = await listMembers();
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
  }

  return (
    <div className="flex w-full max-w-5xl flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("Shared.members.invite")}</h2>
          </CardTitle>
          <CardDescription>{t("Shared.members.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <InviteMemberForm />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("Shared.members.title")}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loadError ? (
            <p className="text-error text-sm">
              {t("Shared.members.loadFailed", { error: loadError })}
            </p>
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
    </div>
  );
}
