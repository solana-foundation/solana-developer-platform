import { MEMBER_STATUSES } from "@sdp/types/organizations";
import { ORGANIZATION_ROLES } from "@sdp/types/roles";
import { z } from "zod";
import { createOrgSdpApiClient } from "@/lib/sdp-api";

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
export type PendingInvitation = z.infer<typeof pendingInvitationSchema>;
type MemberDirectory = z.infer<typeof memberDirectorySchema>;

const MEMBERS_PAGE_SIZE = 25;

// Membership is organization-wide, so the list reads without a project.
export async function listMembers(page: number): Promise<MemberDirectory> {
  const client = await createOrgSdpApiClient();
  const query = new URLSearchParams({
    page: String(Math.max(1, page)),
    pageSize: String(MEMBERS_PAGE_SIZE),
  });
  return memberDirectorySchema.parse(
    await client.fetch<unknown>(`/v1/members?${query.toString()}`)
  );
}
