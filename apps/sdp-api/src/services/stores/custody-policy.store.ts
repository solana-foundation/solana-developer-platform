import type { SdpEnvironment } from "@sdp/types/api-keys";
import {
  PROVIDER_POLICY_REASONS,
  PROVIDER_POLICY_STATUSES,
  type ProviderPolicyCheck,
} from "@sdp/types/custody";
import { z } from "zod";
import type { DatabaseExecutor } from "@/db/client";
import { parsePostgresJson } from "@/db/postgres-utils";
import type { CredentialSecretStorageBackend } from "@/services/credential-secret-store";

const storedPolicySchema = z.object({
  credentialId: z.string(),
  status: z.enum(PROVIDER_POLICY_STATUSES),
  reason: z.enum(PROVIDER_POLICY_REASONS),
  checkedAt: z.string().datetime(),
});
export interface PolicyCheckTarget {
  id: string;
  wallet_id: string;
  organization_id: string;
  project_id: string;
  custody_connection_id: string;
  provider: "privy" | "fireblocks";
  provider_credential_id: string;
  source: "stored" | "runtime";
  storage_backend: CredentialSecretStorageBackend;
  secret_ref: string | null;
  secret_version_ref: string | null;
  encrypted_secret_payload: string | null;
  claim: string;
  /** The observation the wallet already holds, if any; audited writes compare against it. */
  previous_status: string | null;
  previous_reason: string | null;
  previous_credential_id: string | null;
}
export type PolicyCheckScope = {
  environment: SdpEnvironment;
  connection?: { organizationId: string; projectId: string; id: string };
};
const notChecked = (): ProviderPolicyCheck => ({
  status: "unknown",
  reason: "not_checked",
  checkedAt: null,
});

export class CustodyPolicyStore {
  constructor(private readonly db: DatabaseExecutor) {}

  /** Atomic claim prevents overlapping workers from reading the same wallet. Crashes retry in five minutes. */
  async claim(scope: PolicyCheckScope, limit: number): Promise<PolicyCheckTarget[]> {
    return this.db.queryMany<PolicyCheckTarget>(
      `
      WITH due AS (
        SELECT w.id FROM custody_wallets w
        JOIN custody_connections c ON c.id = w.custody_connection_id
        JOIN provider_credentials pc ON pc.id = c.provider_credential_id
        JOIN projects p ON p.id = c.project_id AND p.organization_id = c.organization_id
        WHERE w.status = 'active' AND c.status = 'active' AND pc.status = 'active'
          AND c.provider IN ('fireblocks', 'privy') AND p.status = 'active' AND p.environment = ?
          ${scope.connection ? "AND c.organization_id = ? AND c.project_id = ? AND c.id = ?" : ""}
          AND (w.policy_check_claimed_at IS NULL OR w.policy_check_claimed_at < NOW() - INTERVAL '5 minutes')
          AND (w.provider_policy IS NULL OR w.provider_policy->>'credentialId' IS DISTINCT FROM c.provider_credential_id
            OR (w.provider_policy->>'checkedAt')::timestamptz < NOW() - INTERVAL '1 hour')
        ORDER BY w.policy_check_claimed_at ASC NULLS FIRST, w.id
        LIMIT ? FOR UPDATE OF w SKIP LOCKED
      ), claimed AS (
        UPDATE custody_wallets w SET policy_check_claimed_at = clock_timestamp()
        FROM due WHERE w.id = due.id RETURNING w.*
      )
      SELECT w.id, w.wallet_id, c.organization_id, c.project_id, w.custody_connection_id,
        c.provider, c.provider_credential_id, pc.source, pc.storage_backend, pc.secret_ref,
        pc.secret_version_ref, pc.encrypted_secret_payload, w.policy_check_claimed_at::text AS claim,
        w.provider_policy->>'status' AS previous_status,
        w.provider_policy->>'reason' AS previous_reason,
        w.provider_policy->>'credentialId' AS previous_credential_id
      FROM claimed w JOIN custody_connections c ON c.id = w.custody_connection_id
      JOIN provider_credentials pc ON pc.id = c.provider_credential_id`,
      [
        scope.environment,
        ...(scope.connection
          ? [scope.connection.organizationId, scope.connection.projectId, scope.connection.id]
          : []),
        limit,
      ]
    );
  }

  /** A rotated/deactivated connection or a newer claim wins over an in-flight observation. */
  async record(target: PolicyCheckTarget, check: ProviderPolicyCheck): Promise<boolean> {
    const row = await this.db.queryOne<{ id: string }>(
      `
      UPDATE custody_wallets w SET provider_policy = ?::jsonb
      FROM custody_connections c JOIN provider_credentials pc ON pc.id = c.provider_credential_id
      WHERE w.id = ? AND w.custody_connection_id = c.id AND c.id = ?
        AND c.organization_id = ? AND c.project_id = ? AND c.provider_credential_id = ?
        AND c.status = 'active' AND pc.status = 'active' AND w.status = 'active'
        AND w.policy_check_claimed_at = ?::timestamptz RETURNING w.id`,
      [
        JSON.stringify({ ...check, credentialId: target.provider_credential_id }),
        target.id,
        target.custody_connection_id,
        target.organization_id,
        target.project_id,
        target.provider_credential_id,
        target.claim,
      ]
    );
    return row !== null;
  }

  async read(
    organizationId: string,
    projectId: string,
    target: { walletId: string } | { connectionId: string }
  ): Promise<ProviderPolicyCheck> {
    const rows = await this.db.queryMany<{
      provider_policy: unknown;
      provider_credential_id: string;
    }>(
      `
      SELECT w.provider_policy, c.provider_credential_id FROM custody_wallets w
      JOIN custody_connections c ON c.id = w.custody_connection_id
      WHERE c.organization_id = ? AND c.project_id = ? AND w.status = 'active'
        AND ${"walletId" in target ? "w.id" : "c.id"} = ?`,
      [organizationId, projectId, "walletId" in target ? target.walletId : target.connectionId]
    );
    const checks = rows.map((row): ProviderPolicyCheck => {
      const value = parsePostgresJson<unknown>(row.provider_policy);
      if (value === null) return notChecked();
      const check = storedPolicySchema.parse(value);
      if (check.credentialId !== row.provider_credential_id)
        return { status: "unknown", reason: "credential_changed", checkedAt: null };
      if (Date.now() - Date.parse(check.checkedAt) >= 2 * 60 * 60 * 1000)
        return { status: "unknown", reason: "stale", checkedAt: check.checkedAt };
      return { status: check.status, reason: check.reason, checkedAt: check.checkedAt };
    });
    // A confirmed missing wallet remains visible even when another wallet is unobservable.
    const missing = checks.find((check) => check.status === "missing");
    if (missing) return missing;
    const unknown = checks.find((check) => check.status === "unknown");
    if (unknown) return unknown;
    return (
      checks.sort((a, b) => String(a.checkedAt).localeCompare(String(b.checkedAt)))[0] ??
      notChecked()
    );
  }
}
