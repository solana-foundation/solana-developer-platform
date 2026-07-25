import { listMembers, type Member, type PendingInvitation } from "@/app/members/actions";
import { Badge } from "@/components/ui/badge";
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
import { readableApiError } from "@/lib/sdp-api-error";
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
  let invitations: PendingInvitation[] = [];
  let loadError: string | null = null;

  // A failed list must not take the invite form down with it — an admin whose
  // org list is erroring can still need to add someone.
  try {
    const directory = await listMembers();
    members = directory.members;
    invitations = directory.invitations;
  } catch (error) {
    loadError = readableApiError(error);
  }

  const isEmpty = members.length === 0 && invitations.length === 0;

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
        ) : isEmpty ? (
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

              {/* Invited people hold no membership row until they accept, so
                  without this an invite looks like it did nothing. */}
              {invitations.map((invitation) => (
                <TableRow key={invitation.id}>
                  <TableCell className="min-w-0">
                    <span className="flex items-center gap-2">
                      <span className="truncate font-medium text-primary text-sm">
                        {invitation.email}
                      </span>
                      <Badge variant="warning">{t("Shared.members.statusPending")}</Badge>
                    </span>
                    <span className="block truncate text-muted text-xs">
                      {t("Shared.members.invitedOn", { date: formatJoined(invitation.createdAt) })}
                    </span>
                  </TableCell>
                  <TableCell className="text-secondary text-sm">
                    {roleLabel(invitation.role, t)}
                  </TableCell>
                  <TableCell className="text-muted text-sm">—</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
