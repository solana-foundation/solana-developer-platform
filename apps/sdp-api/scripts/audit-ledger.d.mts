/**
 * Type surface for scripts/audit-ledger.mjs, consumed by tests that import
 * the exported inspection helpers. Keep structurally identical to the runtime
 * module.
 */

import type { Redis } from "ioredis";
import type { Client } from "pg";

export declare const AUDIT_LEDGER_SYSTEM_COMPONENT: "script:audit-ledger";

export declare function systemIdentitySessionStatement(): string;

export declare function requireStampedSystemIdentity(client: Client): Promise<{
  identity: string;
  actor: string;
}>;

export interface AuditLedgerInspection {
  valid: boolean;
  databaseLedgerValid: boolean;
  checkedEntries: number;
  firstInvalidSequence: number | null;
  headHash: string | null;
  unresolvedCriticalIntents: number;
  externalCheckpointMatches: boolean;
  externalCheckpoint: string | null;
  expectedCheckpoint: string | null;
  runtimeRoleProtected: boolean;
  runtimeRole: string | null;
  systemIdentity: string | null;
  tableOwner: string | null;
  superuser: boolean | null;
  bypassRls: boolean | null;
  rowSecurity: boolean | null;
  forceRowSecurity: boolean | null;
  anchorsRowSecurity: boolean | null;
  anchorsForceRowSecurity: boolean | null;
  enabledSecurityTriggers: number;
}

export declare function inspect(
  client: Client,
  redis: Pick<Redis, "get">,
  approvedCheckpoint?: string
): Promise<AuditLedgerInspection>;
