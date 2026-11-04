import type { OrganizationRole } from "@sdp/types/roles";
import { useState } from "react";
import type { MemberIdentity } from "./member-identity";

export type DirectoryMember = {
  id: string;
  identity: MemberIdentity;
  role: OrganizationRole;
  joinedOn: string | null;
  isSelf: boolean;
  isLastAdmin: boolean;
};

export type DirectoryInvitation = {
  id: string;
  email: string;
  role: OrganizationRole;
  invitedOn: string | null;
};

export const MEMBERS_FILTERS = ["all", "members", "invited"] as const;
export type MembersFilter = (typeof MEMBERS_FILTERS)[number];

function matchesQuery(query: string, texts: readonly (string | null)[]): boolean {
  return query === "" || texts.some((text) => text?.toLowerCase().includes(query));
}

function emptyReason(query: string, filter: MembersFilter): "noMatch" | "noInvitations" | "empty" {
  if (query !== "") return "noMatch";
  if (filter === "invited") return "noInvitations";
  return "empty";
}

// The API caps an organization at fewer people, pending invitations included, than one page
// holds, so searching and filtering here always covers the whole directory.
export function useMembersDirectoryView(
  members: readonly DirectoryMember[],
  invitations: readonly DirectoryInvitation[]
) {
  const [filter, setFilter] = useState<MembersFilter>("all");
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  // A filter or search the person set keeps its controls on screen after the rows it matched are
  // gone (the last invitation revoked under Invited), so they can always undo it.
  const isNarrowed = filter !== "all" || normalizedQuery !== "";
  const shownInvitations =
    filter === "members"
      ? []
      : invitations.filter((invitation) => matchesQuery(normalizedQuery, [invitation.email]));
  const shownMembers =
    filter === "invited"
      ? []
      : members.filter((member) =>
          matchesQuery(normalizedQuery, [member.identity.label, member.identity.secondary])
        );

  return {
    filter,
    setFilter,
    query,
    setQuery,
    showsToolbar: members.length + invitations.length > 1 || isNarrowed,
    showsFilter: invitations.length > 0 || filter !== "all",
    shownInvitations,
    shownMembers,
    empty:
      shownInvitations.length + shownMembers.length === 0
        ? emptyReason(normalizedQuery, filter)
        : null,
  };
}
