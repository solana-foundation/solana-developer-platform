"use client";

import { MEMBER_STATUSES } from "@sdp/types/organizations";
import { ORGANIZATION_ROLES } from "@sdp/types/roles";
import { z } from "zod";
import { useDashboardKeyScope, useDashboardRead } from "@/lib/dashboard-swr";
import { membersQueryKeys } from "./members-query-key";

const memberSchema = z.object({
  id: z.string(),
  role: z.enum(ORGANIZATION_ROLES),
  status: z.enum(MEMBER_STATUSES),
  createdAt: z.string(),
  /** Set by the API; the client holds emails, not the actor's user id. */
  isSelf: z.boolean(),
  user: z.object({ id: z.string(), email: z.string(), name: z.string().nullable() }),
});

const pendingInvitationSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: z.enum(ORGANIZATION_ROLES),
  status: z.literal("pending"),
  createdAt: z.string(),
  expiresAt: z.string(),
});

const memberDirectorySchema = z.object({
  members: z.array(memberSchema),
  invitations: z.array(pendingInvitationSchema),
  meta: z.object({
    total: z.number(),
    page: z.number(),
    pageSize: z.number(),
    hasMore: z.boolean(),
    activeAdminCount: z.number(),
  }),
});

export type Member = z.infer<typeof memberSchema>;

const memberDirectoryResponseSchema = z.object({ data: memberDirectorySchema });

/** The last page stays up while the next one loads. */
export function useMembersDirectory(page: number) {
  const scope = useDashboardKeyScope();
  const response = useDashboardRead(
    membersQueryKeys.directory(scope, { page }),
    memberDirectoryResponseSchema,
    { keepPreviousData: true }
  );
  return { ...response, data: response.data?.data };
}
