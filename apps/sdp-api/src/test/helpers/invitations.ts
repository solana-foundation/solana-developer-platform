import assert from "node:assert/strict";
import { INVITATION_STATUSES, type InvitationStatus } from "@sdp/types/organizations";
import type { OrganizationRole } from "@sdp/types/roles";
import { z } from "zod";
import type { DatabaseClient } from "@/db/client";

/** Seeds an invitation row; `invitedBy` must be a seeded user and a negative `expiresInDays` is already expired. */
export async function seedInvitation(
  db: DatabaseClient,
  input: {
    id: string;
    organizationId: string;
    email: string;
    role: OrganizationRole;
    invitedBy: string;
    status: InvitationStatus;
    expiresInDays: number;
  }
): Promise<void> {
  await db.execute(
    `INSERT INTO invitations (id, organization_id, email, role, invited_by, token_hash, expires_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      input.organizationId,
      input.email,
      input.role,
      input.invitedBy,
      input.id,
      new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000).toISOString(),
      input.status,
    ]
  );
}

/** Reads an invitation's stored status. */
export async function readInvitationStatus(
  db: DatabaseClient,
  invitationId: string
): Promise<InvitationStatus> {
  const row = await db.queryOne<{ status: string }>("SELECT status FROM invitations WHERE id = ?", [
    invitationId,
  ]);
  assert(row);
  return z.enum(INVITATION_STATUSES).parse(row.status);
}
