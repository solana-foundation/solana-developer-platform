"use client";

import type { OrganizationRole } from "@sdp/types/roles";
import { Badge } from "@sdp/ui/badge";
import { cn } from "@sdp/ui/cn";
import { ListToolbar } from "@sdp/ui/list-toolbar";
import { SearchInput } from "@sdp/ui/search-input";
import { SegmentedControl } from "@sdp/ui/segmented-control";
import { TableCell } from "@sdp/ui/table";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@solana/design-system/table";
import {
  PAYMENTS_TABLE_CELL,
  PAYMENTS_TABLE_HEAD,
} from "@/app/(session)/dashboard/[projectId]/payments/payments-table";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { InvitationActions } from "./invitation-actions";
import { MemberActions } from "./member-actions";
import {
  type DirectoryInvitation,
  type DirectoryMember,
  MEMBERS_FILTERS,
  useMembersDirectoryView,
} from "./use-members-directory-view";

const ROLE_LABEL_KEYS = {
  admin: "Shared.members.roleAdmin",
  member: "Shared.members.roleMember",
  viewer: "Shared.members.roleViewer",
} as const satisfies Record<OrganizationRole, MessageKey>;

const EMPTY_MESSAGE_KEYS = {
  noInvitations: "Shared.members.noInvitations",
  empty: "Shared.members.empty",
} as const satisfies Record<string, MessageKey>;

export function MembersDirectory({
  members,
  invitations,
}: {
  members: readonly DirectoryMember[];
  invitations: readonly DirectoryInvitation[];
}) {
  const t = useTranslations();
  const view = useMembersDirectoryView(members, invitations);

  return (
    <>
      {view.showsToolbar ? (
        <MembersToolbar
          view={view}
          memberCount={members.length}
          invitationCount={invitations.length}
        />
      ) : null}

      {view.empty ? (
        <p className="py-6 text-body text-secondary">
          {view.empty === "noMatch"
            ? t("Shared.members.noMatch", { query: view.query.trim() })
            : t(EMPTY_MESSAGE_KEYS[view.empty])}
        </p>
      ) : (
        <Table className="rounded-none border-0">
          <TableHeader>
            <TableRow>
              <TableHead className={PAYMENTS_TABLE_HEAD}>
                {t("Shared.members.columnName")}
              </TableHead>
              <TableHead className={cn(PAYMENTS_TABLE_HEAD, "w-32")}>
                {t("Shared.members.columnRole")}
              </TableHead>
              <TableHead className={cn(PAYMENTS_TABLE_HEAD, "w-48")}>
                {t("Shared.members.columnStatus")}
              </TableHead>
              <TableHead className="w-12">
                <span className="sr-only">{t("Shared.members.columnActions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {/* Invited people hold no membership row until they accept, so without these an
                invite looks like it did nothing. */}
            {view.shownInvitations.map((invitation) => (
              <InvitationRow key={invitation.id} invitation={invitation} />
            ))}
            {view.shownMembers.map((member) => (
              <MemberRow key={member.id} member={member} />
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}

function MembersToolbar({
  view,
  memberCount,
  invitationCount,
}: {
  view: ReturnType<typeof useMembersDirectoryView>;
  memberCount: number;
  invitationCount: number;
}) {
  const t = useTranslations();
  return (
    <ListToolbar
      filters={
        view.showsFilter ? (
          <SegmentedControl
            ariaLabel={t("Shared.members.filterLabel")}
            value={view.filter}
            onChange={(next) => {
              const picked = MEMBERS_FILTERS.find((candidate) => candidate === next);
              if (picked) view.setFilter(picked);
            }}
            options={[
              {
                value: "all",
                label: t("Shared.members.filterAll", {
                  count: memberCount + invitationCount,
                }),
              },
              {
                value: "members",
                label: t("Shared.members.filterMembers", { count: memberCount }),
              },
              {
                value: "invited",
                label: t("Shared.members.filterInvited", { count: invitationCount }),
              },
            ]}
          />
        ) : (
          <span className="text-body text-secondary tabular-nums">
            {memberCount === 1
              ? t("Shared.members.memberCountOne")
              : t("Shared.members.memberCount", { count: memberCount })}
          </span>
        )
      }
    >
      <SearchInput
        value={view.query}
        onChange={(event) => view.setQuery(event.target.value)}
        clear={{ label: t("Shared.members.clearSearch"), onClear: () => view.setQuery("") }}
        placeholder={t("Shared.members.searchPlaceholder")}
        aria-label={t("Shared.members.searchLabel")}
        className="min-w-0 flex-1 sm:w-56 sm:flex-none"
      />
    </ListToolbar>
  );
}

function InvitationRow({ invitation }: { invitation: DirectoryInvitation }) {
  const t = useTranslations();
  return (
    <TableRow>
      <TableCell className={cn(PAYMENTS_TABLE_CELL, "max-w-64")}>
        <span className="block truncate font-medium text-body text-primary">
          {invitation.email}
        </span>
      </TableCell>
      <TableCell className={cn(PAYMENTS_TABLE_CELL, "text-secondary")}>
        {t(ROLE_LABEL_KEYS[invitation.role])}
      </TableCell>
      <TableCell className={cn(PAYMENTS_TABLE_CELL, "text-secondary")}>
        <span className="flex items-center gap-1.5">
          <Badge variant="warning">{t("Shared.members.statusPending")}</Badge>
          {invitation.invitedOn ? (
            <span className="whitespace-nowrap">
              {t("Shared.members.invitedOn", { date: invitation.invitedOn })}
            </span>
          ) : null}
        </span>
      </TableCell>
      <TableCell className="text-right">
        <InvitationActions invitationId={invitation.id} email={invitation.email} />
      </TableCell>
    </TableRow>
  );
}

function MemberRow({ member }: { member: DirectoryMember }) {
  const t = useTranslations();
  return (
    <TableRow>
      <TableCell className={cn(PAYMENTS_TABLE_CELL, "max-w-64")}>
        {/* Without a name the email is the identity, so it moves up rather than
                      sitting under an "Unnamed" placeholder that says nothing and reads as an
                      error. */}
        <span className="block truncate font-medium text-body text-primary">
          {member.identity.label}
        </span>
        {member.identity.secondary ? (
          <span
            className={cn(
              "block truncate text-secondary",
              member.identity.isUnresolved && "font-mono"
            )}
          >
            {member.identity.secondary}
          </span>
        ) : null}
        {member.identity.isUnresolved ? (
          <span className="block truncate text-secondary">
            {t("Shared.members.emailUnavailable")}
          </span>
        ) : null}
      </TableCell>
      <TableCell className={cn(PAYMENTS_TABLE_CELL, "text-secondary")}>
        {t(ROLE_LABEL_KEYS[member.role])}
      </TableCell>
      <TableCell className={cn(PAYMENTS_TABLE_CELL, "text-secondary")}>
        {member.joinedOn ? t("Shared.members.joinedOn", { date: member.joinedOn }) : null}
      </TableCell>
      <TableCell className="text-right">
        <MemberActions
          memberId={member.id}
          label={member.identity.actionLabel}
          role={member.role}
          isSelf={member.isSelf}
          isLastAdmin={member.isLastAdmin}
        />
      </TableCell>
    </TableRow>
  );
}
