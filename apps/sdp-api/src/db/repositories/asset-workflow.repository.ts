import type {
  ReviewMode,
  WorkflowActionType,
  WorkflowCondition,
  WorkflowRetryPolicy,
  WorkflowRuleAction,
  WorkflowTriggerType,
} from "@sdp/types";
import type { StoredCredentialSecret } from "@/services/credential-secret-store";
import type { RepositoryDbClient } from "./base";

export function generateAssetWorkflowId(): string {
  return `asset_workflow_${crypto.randomUUID()}`;
}

// Stored under asset_workflows.definition JSONB.
export interface AssetWorkflowDefinition {
  condition: WorkflowCondition | null;
  action: WorkflowRuleAction;
  retryPolicy: WorkflowRetryPolicy;
  // Credential params (today: the outbound webhook HMAC secret) live here as a
  // secret-store reference rather than as a plaintext value in `action.params` —
  // the definition JSONB is read by list endpoints and dumped by any DB export.
  actionSecret?: StoredCredentialSecret | null;
}

export interface AssetWorkflowRow {
  id: string;
  organization_id: string;
  project_id: string;
  token_id: string;
  trigger_type: WorkflowTriggerType;
  action_type: WorkflowActionType;
  definition: AssetWorkflowDefinition;
  version: number;
  enabled: boolean;
  review_mode: ReviewMode;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  // Set by the soft delete; null on live rows. Only reads that opt into
  // `includeDeleted` ever see a non-null value.
  deleted_at: string | null;
}

export interface CreateAssetWorkflowInput {
  // Callers that must reference the rule before it exists supply their own id — the
  // webhook signing secret is keyed by rule id and is written first, so that a store
  // failure leaves no row behind. Everyone else lets the repository mint one.
  id?: string;
  organizationId: string;
  projectId: string;
  tokenId: string;
  triggerType: WorkflowTriggerType;
  actionType: WorkflowActionType;
  definition: AssetWorkflowDefinition;
  version: number;
  reviewMode: ReviewMode;
  enabled?: boolean;
  createdBy?: string | null;
  // The credential this row is about to reference, provisionally queued for destruction
  // before the row was attempted. Committing the row cancels that obligation in the same
  // transaction. See `clearRetirementFor` on UpdateAssetWorkflowInput.
  clearRetirementFor?: StoredCredentialSecret | null;
}

export interface UpdateAssetWorkflowInput {
  workflowId: string;
  organizationId: string;
  projectId: string;
  definition?: AssetWorkflowDefinition;
  reviewMode?: ReviewMode;
  enabled?: boolean;
  // A credential this write orphans — the version a rotation supersedes. Queued for
  // destruction in the SAME transaction as the write, because a record written afterwards
  // is lost precisely when the database is what failed, and nothing else would ever
  // retry. Ignored unless it names a backend with an external version to destroy.
  retireSecret?: StoredCredentialSecret | null;
  // The mirror image: a credential this write makes REFERENCED — the version a rotation
  // installs. It was queued for destruction before the write was attempted, which is the
  // only ordering in which a rejected write cannot strand it, so committing the reference
  // cancels the obligation in the same transaction. Either the row points at the version
  // or the version is queued for destruction; there is no state where neither holds.
  clearRetirementFor?: StoredCredentialSecret | null;
}

export interface AssetWorkflowsRepositoryContext {
  db: RepositoryDbClient;
}

export interface AssetWorkflowsRepository {
  createWorkflow(input: CreateAssetWorkflowInput): Promise<AssetWorkflowRow | null>;
  updateWorkflow(input: UpdateAssetWorkflowInput): Promise<AssetWorkflowRow | null>;
  // Soft delete (keeps the rule's execution history; hard DELETE would cascade).
  // Returns false when the rule doesn't exist or is already deleted.
  deleteWorkflow(params: {
    workflowId: string;
    organizationId: string;
    projectId: string;
    // The rule's own signing key: orphaned the moment the delete commits, so its
    // retirement is recorded by the same transaction. See UpdateAssetWorkflowInput.
    retireSecret?: StoredCredentialSecret | null;
  }): Promise<boolean>;
  getWorkflowById(params: {
    workflowId: string;
    organizationId: string;
    projectId: string;
    // Soft-deleted rows are invisible to every read path by default. The delete
    // handler alone opts in, so a retry of a delete whose cleanup failed can find
    // the row it soft-deleted and finish the job instead of 404ing.
    includeDeleted?: boolean;
  }): Promise<AssetWorkflowRow | null>;
  listWorkflowsForToken(params: {
    tokenId: string;
    organizationId: string;
    projectId: string;
  }): Promise<AssetWorkflowRow[]>;
  // Dispatcher hot path: enabled rules for a project + trigger type. Token-scoped
  // events pass tokenId so the filter happens in SQL, not in JS over all rules.
  listEnabledWorkflowsForTrigger(params: {
    organizationId: string;
    projectId: string;
    triggerType: WorkflowTriggerType;
    tokenId?: string;
  }): Promise<AssetWorkflowRow[]>;
}
