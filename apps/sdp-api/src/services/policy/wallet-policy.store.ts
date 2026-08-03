import { IMPLICIT_DEFAULT_ALLOW_POLICY } from "@sdp/policy";
import type {
  EffectiveWalletPolicy,
  WalletControlProfile,
  WalletControlProfileRevision,
} from "@sdp/types";
import type {
  ApiKeyWalletPolicyTargetRow,
  PolicyRepository,
  WalletControlProfileRevisionRow,
  WalletControlProfileRow,
} from "@/db/repositories";
import { forbidden } from "@/lib/errors";

/** Wallet-scope policy resolution: active control profiles keyed by custody wallet. */
export class WalletPolicyStore {
  constructor(private readonly repository: PolicyRepository) {}

  /**
   * Resolve the effective policy for a custody wallet: its active control
   * profile revision, or implicit default allow when none is active.
   *
   * @param custodyWalletId - The custody wallet to resolve.
   * @returns The effective wallet policy.
   */
  async resolveEffectiveWalletPolicy(custodyWalletId: string): Promise<EffectiveWalletPolicy> {
    const active =
      await this.repository.getActiveWalletControlProfileByCustodyWalletId(custodyWalletId);

    if (!active?.revision) {
      return IMPLICIT_DEFAULT_ALLOW_POLICY;
    }

    return {
      source: "customer_profile",
      profile: mapWalletControlProfile(active.profile),
      revision: mapWalletControlProfileRevision(active.revision),
      defaultAction: active.revision.default_action,
    };
  }

  /**
   * Resolve a wallet control profile referenced by an API-key wallet binding,
   * asserting it is active and scoped to the binding's target wallet.
   *
   * @param profileId - The bound wallet control profile.
   * @param target - The resolved binding target.
   * @returns The effective wallet policy the binding supplies.
   */
  async resolveWalletPolicyProfileForBinding(
    profileId: string,
    target: ApiKeyWalletPolicyTargetRow
  ): Promise<EffectiveWalletPolicy> {
    const active = await this.repository.getActiveWalletControlProfileByProfileId(profileId);

    if (!active?.revision) {
      throw forbidden("Wallet policy profile is not active for the requested wallet binding");
    }

    if (
      active.profile.custody_wallet_id !== target.custody_wallet_id ||
      active.profile.organization_id !== target.organization_id ||
      (active.profile.project_id !== null && active.profile.project_id !== target.wallet_project_id)
    ) {
      throw forbidden("Wallet policy profile is not scoped to the requested wallet");
    }

    return {
      source: "customer_profile",
      profile: mapWalletControlProfile(active.profile),
      revision: mapWalletControlProfileRevision(active.revision),
      defaultAction: active.revision.default_action,
    };
  }
}

function mapWalletControlProfile(row: WalletControlProfileRow): WalletControlProfile {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    custodyWalletId: row.custody_wallet_id,
    name: row.name,
    status: row.status,
    activeRevisionId: row.active_revision_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    activatedAt: row.activated_at,
    archivedAt: row.archived_at,
  };
}

function mapWalletControlProfileRevision(
  row: WalletControlProfileRevisionRow
): WalletControlProfileRevision {
  return {
    id: row.id,
    profileId: row.profile_id,
    revisionNumber: row.revision_number,
    rules: row.rules as unknown as WalletControlProfileRevision["rules"],
    defaultAction: row.default_action,
    createdBy: row.created_by,
    createdAt: row.created_at,
    activatedAt: row.activated_at,
  };
}
