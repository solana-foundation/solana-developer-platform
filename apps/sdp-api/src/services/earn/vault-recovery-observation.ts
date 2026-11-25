import type { SdpEnvironment } from "@sdp/types/api-keys";

interface RecoveryTransaction {
  id: string;
  organization_id: string;
  project_id: string | null;
  environment: SdpEnvironment;
  signature: string | null;
  signed_transaction: string | null;
  last_valid_block_height: string | null;
}

interface RecoveryState {
  status: string;
  updated_at: string;
  unknown_signature_observed_at: string | null;
  absent_creation_observed_at?: string | null;
}

/** Sweep-local chain evidence belongs only to the exact signed transaction observed. */
export function matchesEarnRecoveryTransaction(
  snapshot: RecoveryTransaction,
  current: RecoveryTransaction
): boolean {
  return (
    snapshot.id === current.id &&
    snapshot.organization_id === current.organization_id &&
    snapshot.project_id === current.project_id &&
    snapshot.environment === current.environment &&
    snapshot.signature === current.signature &&
    snapshot.signed_transaction === current.signed_transaction &&
    snapshot.last_valid_block_height === current.last_valid_block_height
  );
}

/** An earlier absence cannot count as a later observation after durable state advances. */
export function unchangedEarnRecoveryState(
  snapshot: RecoveryState,
  current: RecoveryState
): boolean {
  return (
    snapshot.status === current.status &&
    snapshot.updated_at === current.updated_at &&
    snapshot.unknown_signature_observed_at === current.unknown_signature_observed_at &&
    snapshot.absent_creation_observed_at === current.absent_creation_observed_at
  );
}
