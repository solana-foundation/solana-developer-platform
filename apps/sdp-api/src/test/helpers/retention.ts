import { wellKnownMint } from "@sdp/types/well-known-tokens";
import type { DatabaseClient } from "@/db/client";
import { seedDefaultProjects } from "./projects";
import { required } from "./required";

/** Seed old business and recovery rows that account PII cleanup must preserve. */
export async function seedRetentionEvidence(
  db: DatabaseClient,
  owner: { organizationId: string; userId: string }
): Promise<void> {
  const projectId = "prj_retention_evidence";
  await seedDefaultProjects(db, {
    organizationId: owner.organizationId,
    createdBy: owner.userId,
    members: [owner.userId],
    ids: { sandbox: projectId, production: `${projectId}_production` },
  });
  const token = required(wellKnownMint("SOL", "devnet"));
  const old = "2020-01-01T00:00:00.000Z";
  await db.execute(
    `INSERT INTO counterparties (id, organization_id, project_id, entity_type, display_name, status, created_by)
     VALUES ('cpty_retention_evidence', ?, ?, 'individual', 'Business contact', 'active', ?)`,
    [owner.organizationId, projectId, owner.userId]
  );
  await db.execute(
    `INSERT INTO payment_transfers
       (id, organization_id, project_id, wallet_id, source_address, destination_address, token,
        amount, memo, type, direction, status, signature, serialized_tx, created_at, updated_at)
     VALUES ('xfr_retention_evidence', ?, ?, 'wallet_evidence', 'Source', 'Destination', ?,
       '1000', 'business memo', 'transfer', 'outbound', 'processing', 'pending-signature', 'signed-bytes', ?, ?)`,
    [owner.organizationId, projectId, token, old, old]
  );
  await db.execute(
    `INSERT INTO payment_transfer_batches
       (id, organization_id, project_id, external_id, source_wallet_id, source_address, token, status, created_at, updated_at)
     VALUES ('batch_retention_evidence', ?, ?, 'durable-business-dedupe', 'wallet_evidence', 'Source', ?, 'processing', ?, ?)`,
    [owner.organizationId, projectId, token, old, old]
  );
  await db.execute(
    `INSERT INTO ramp_webhook_events (id, provider, environment, payload, status, created_at, updated_at)
     VALUES ('rwe_retention_evidence', 'moonpay', 'sandbox', '{"unresolved":"settlement evidence"}'::jsonb, 'failed', ?, ?)`,
    [old, old]
  );
}

/** Read complete recovery rows so unintended field changes fail the regression. */
export async function readRetentionEvidence(db: DatabaseClient) {
  return {
    counterparties: await db.queryMany("SELECT * FROM counterparties ORDER BY id"),
    transfers: await db.queryMany("SELECT * FROM payment_transfers ORDER BY id"),
    batches: await db.queryMany("SELECT * FROM payment_transfer_batches ORDER BY id"),
    webhooks: await db.queryMany("SELECT * FROM ramp_webhook_events ORDER BY id"),
  };
}
