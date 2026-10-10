import type { FireblocksPolicyForm } from "@sdp/types";
import type { AppDb } from "@/db";
import type { FireblocksBookScope } from "./fireblocks-address-book.repository";
export interface FireblocksPolicyProposal {
  id: string;
  selection_key: string;
  form: FireblocksPolicyForm;
  account_fingerprint: string;
  request_hash: string;
  active_revision: string;
  draft_id: string | null;
  draft_revision: string | null;
  state: "preparing" | "draft" | "invalid" | "submitting" | "submitted" | "unknown" | "failed";
}
export class FireblocksPolicyRepository {
  constructor(
    private readonly db: AppDb,
    private readonly scope: FireblocksBookScope
  ) {}
  private values() {
    return [this.scope.organizationId, this.scope.projectId, this.scope.connectionId];
  }
  async find(id: string) {
    return this.db.queryOne<FireblocksPolicyProposal>(
      "SELECT * FROM fireblocks_policy_proposals WHERE organization_id = ? AND project_id = ? AND connection_id = ? AND id = ?",
      [...this.values(), id]
    );
  }
  async existing(requestId: string) {
    return this.db.queryOne<FireblocksPolicyProposal>(
      "SELECT * FROM fireblocks_policy_proposals WHERE organization_id = ? AND project_id = ? AND connection_id = ? AND request_id = ?",
      [...this.values(), requestId]
    );
  }
  async open(fingerprint: string) {
    return this.db.queryOne<FireblocksPolicyProposal>(
      "SELECT * FROM fireblocks_policy_proposals WHERE organization_id = ? AND project_id = ? AND connection_id = ? AND account_fingerprint = ? AND state IN ('preparing','draft','invalid','submitting','unknown')",
      [...this.values(), fingerprint]
    );
  }
  async claim(
    requestId: string,
    requestHash: string,
    fingerprint: string,
    revision: string,
    selectionKey: string,
    form: FireblocksPolicyForm
  ) {
    return this.db.queryOne<FireblocksPolicyProposal>(
      `INSERT INTO fireblocks_policy_proposals (id, organization_id, project_id, connection_id, account_fingerprint, request_id, request_hash, active_revision, selection_key, form, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, 'preparing') ON CONFLICT DO NOTHING RETURNING *`,
      [
        `fbpol_${crypto.randomUUID()}`,
        ...this.values(),
        fingerprint,
        requestId,
        requestHash,
        revision,
        selectionKey,
        JSON.stringify(form),
      ]
    );
  }
  async update(
    id: string,
    state: FireblocksPolicyProposal["state"],
    draftId?: string,
    draftRevision?: string
  ) {
    await this.db.execute(
      `UPDATE fireblocks_policy_proposals SET state = ?, draft_id = COALESCE(?, draft_id), draft_revision = COALESCE(?, draft_revision), updated_at = sdp_iso_now()
      WHERE organization_id = ? AND project_id = ? AND connection_id = ? AND id = ?`,
      [state, draftId ?? null, draftRevision ?? null, ...this.values(), id]
    );
  }
  async claimPublish(id: string) {
    return this.db.queryOne<FireblocksPolicyProposal>(
      `UPDATE fireblocks_policy_proposals SET state = 'submitting', updated_at = sdp_iso_now()
      WHERE organization_id = ? AND project_id = ? AND connection_id = ? AND id = ? AND state = 'draft' RETURNING *`,
      [...this.values(), id]
    );
  }
}
