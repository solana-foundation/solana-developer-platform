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
import { InvitationActions } from "./invitation-actions";
import { InviteMemberForm } from "./invite-member-form";
import { MemberActions } from "./member-actions";
import { MembersPagination } from "./members-pagination";

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

/**
 * A misconfigured Clerk JWT template can store an unsubstituted placeholder —
 * literally `{{user.primary_email_address.email_address}}` — as a user's
 * email. Printing that verbatim reads as a rendering bug rather than as the
 * data problem it is, so anything that is not an address is not shown as one.
 */
function displayEmail(value: string): string {
  const trimmed = value?.trim() ?? "";
  const looksLikeAddress = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
  return looksLikeAddress ? trimmed : "—";
}

export async function MembersSection({ page = 1 }: { page?: number }) {
  const t = await getTranslations();

  let members: Member[] = [];
  let invitations: PendingInvitation[] = [];
  let meta = { total: 0, page: 1, pageSize: 25, hasMore: false, activeAdminCount: 0 };
  let loadError: string | null = null;

  // A failed list must not take the invite form down with it — an admin whose
  // org list is erroring can still need to add someone.
  try {
    const directory = await listMembers(page);
    members = directory.members;
    invitations = directory.invitations;
    meta = directory.meta;
  } catch (error) {
    loadError = readableApiError(error);
  }

  const isEmpty = members.length === 0 && invitations.length === 0;

  return (
    // Anchored so the retired /dashboard/members route can deep-link here.
    <Card id="members" className="scroll-mt-6">
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
                <TableHead className="w-16 text-right">
                  <span className="sr-only">{t("Shared.members.columnActions")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((member) => {
                const name = member.user.name?.trim();
                const email = displayEmail(member.user.email);

                return (
                  <TableRow key={member.id}>
                    <TableCell className="min-w-0">
                      {/* Without a name the email is the identity, so it moves
                          up rather than sitting under an "Unnamed" placeholder
                          that says nothing and reads as an error. */}
                      <span className="block truncate font-medium text-primary text-sm">
                        {name || email}
                      </span>
                      {name ? (
                        <span className="block truncate text-muted text-xs">{email}</span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-secondary text-sm">
                      {roleLabel(member.role, t)}
                    </TableCell>
                    <TableCell className="text-secondary text-sm">
                      {formatJoined(member.createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <MemberActions
                        memberId={member.id}
                        label={name || email}
                        isSelf={Boolean(member.isSelf)}
                        isLastAdmin={member.role === "admin" && meta.activeAdminCount <= 1}
                      />
                    </TableCell>
                  </TableRow>
                );
              })}

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
                  <TableCell className="text-right">
                    <InvitationActions
                      invitationId={invitation.id}
                      email={invitation.email}
                      acceptUrl={invitation.acceptUrl}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {!loadError && meta.total > meta.pageSize ? <MembersPagination meta={meta} /> : null}
      </CardContent>
    </Card>
  );
}
