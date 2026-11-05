import { RecordSection } from "@/app/(session)/dashboard/[projectId]/payments/payments-record";
import { getRequestLocale, getTranslations } from "@/i18n/server";
import { formatDate } from "@/lib/date-format";
import { readableApiError } from "@/lib/sdp-api-error";
import { InviteMemberForm } from "./invite-member-form";
import { resolveMemberIdentity } from "./member-identity";
import { MembersDirectory } from "./members-directory";
import { listMembers, type Member, type PendingInvitation } from "./members-load";
import { MembersPagination } from "./members-pagination";

export async function MembersSection({ page }: { page: number }) {
  const [t, locale] = await Promise.all([getTranslations(), getRequestLocale()]);

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

  return (
    <>
      <RecordSection title={t("Shared.members.inviteTitle")}>
        <InviteMemberForm />
      </RecordSection>

      <RecordSection id="members" title={t("Shared.members.title")}>
        {loadError ? (
          <p role="alert" className="text-body text-error">
            {t("Shared.members.loadFailed", { error: loadError })}
          </p>
        ) : (
          <MembersDirectory
            members={members.map((member) => ({
              id: member.id,
              identity: resolveMemberIdentity(member.user, t("Shared.members.unnamedMember")),
              role: member.role,
              joinedOn: formatDate(locale, member.createdAt),
              isSelf: Boolean(member.isSelf),
              isLastAdmin: member.role === "admin" && meta.activeAdminCount <= 1,
            }))}
            invitations={invitations.map((invitation) => ({
              id: invitation.id,
              email: invitation.email,
              role: invitation.role,
              invitedOn: formatDate(locale, invitation.createdAt),
            }))}
          />
        )}

        {!loadError && meta.total > meta.pageSize ? <MembersPagination meta={meta} /> : null}
      </RecordSection>
    </>
  );
}
