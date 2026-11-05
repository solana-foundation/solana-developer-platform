"use client";

import { RecordSection } from "@/app/(session)/dashboard/[projectId]/payments/payments-record";
import { useLocale, useTranslations } from "@/i18n/provider";
import { useTimeZone } from "@/i18n/time-zone";
import { useDashboardSearchParam } from "@/lib/dashboard-url-state";
import { formatDate } from "@/lib/date-format";
import { InviteMemberForm } from "./invite-member-form";
import { resolveMemberIdentity } from "./member-identity";
import { useMembersDirectory } from "./members.data";
import { MembersDirectory } from "./members-directory";
import { MembersPagination } from "./members-pagination";
import {
  SettingsLoadError,
  SettingsRowsSkeleton,
  useReadFailureText,
} from "./settings-section-state";

/** Anything that is not a positive integer is the first page. */
function resolveMembersPage(value: string | null): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export function MembersSection() {
  const t = useTranslations();
  const locale = useLocale();
  const timeZone = useTimeZone();
  const failureText = useReadFailureText();
  const page = resolveMembersPage(useDashboardSearchParam("membersPage"));
  const directory = useMembersDirectory(page);
  const data = directory.data;

  return (
    <>
      {/* A failed list must not take the invite form down with it: an admin whose org list is
          erroring can still need to add someone. */}
      <RecordSection title={t("Shared.members.inviteTitle")}>
        <InviteMemberForm />
      </RecordSection>

      <RecordSection id="members" title={t("Shared.members.title")}>
        {data ? (
          <>
            <MembersDirectory
              members={data.members.map((member) => ({
                id: member.id,
                identity: resolveMemberIdentity(member.user, t("Shared.members.unnamedMember")),
                role: member.role,
                joinedOn: formatDate(locale, timeZone, member.createdAt),
                isSelf: member.isSelf,
                isLastAdmin: member.role === "admin" && data.meta.activeAdminCount <= 1,
              }))}
              invitations={data.invitations.map((invitation) => ({
                id: invitation.id,
                email: invitation.email,
                role: invitation.role,
                invitedOn: formatDate(locale, timeZone, invitation.createdAt),
              }))}
            />
            {data.meta.total > data.meta.pageSize ? <MembersPagination meta={data.meta} /> : null}
          </>
        ) : directory.error ? (
          <SettingsLoadError
            message={t("Shared.members.loadFailed", { error: failureText(directory.error) })}
            onRetry={() => void directory.mutate()}
          />
        ) : (
          <SettingsRowsSkeleton rows={3} />
        )}
      </RecordSection>
    </>
  );
}
