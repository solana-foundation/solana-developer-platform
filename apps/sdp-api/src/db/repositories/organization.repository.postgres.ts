import { MEMBER_STATUSES } from "@sdp/types/organizations";
import { normalizeOrganizationRole } from "@sdp/types/roles";
import { z } from "zod";
import type { DatabaseClient as AppDb } from "@/db/client";
import type { OrganizationRepository } from "./organization.repository";

const membershipRowSchema = z.object({
  role: z.string().transform(normalizeOrganizationRole),
  status: z.enum(MEMBER_STATUSES),
});

export function createPostgresOrganizationRepository(db: AppDb): OrganizationRepository {
  return {
    async findMembership({ organizationId, clerkUserId }) {
      const row = await db
        .prepare(
          `SELECT om.role, om.status
             FROM auth_user_identities aui
             JOIN organization_members om
               ON om.user_id = aui.user_id AND om.organization_id = ?
            WHERE aui.provider = 'clerk' AND aui.provider_user_id = ?`
        )
        .bind(organizationId, clerkUserId)
        .first<Record<string, unknown>>();
      return row ? membershipRowSchema.parse(row) : null;
    },
  };
}
