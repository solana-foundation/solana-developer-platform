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
  // The version this request wrote to the credential store, when it rotated the key. Set
  // it and the write installs that version and retires whatever the row currently holds —
  // read under lock inside the transaction, never taken from the caller, because the
  // caller's view of the stored key predates the transaction and a concurrent rotation
  // makes it name a version that is already gone.
  //
  // Both halves commit with the write. The superseded version is queued for destruction,
  // because a record written afterwards is lost precisely when the database is what
  // failed. The installed version's own provisional obligation — queued before this write
  // was attempted, the only ordering in which a rejected write cannot strand it — is
  // cancelled, so the two reachable states are "the row points at the version" and "the
  // version is queued for destruction", never neither.
  rotateSecretTo?: StoredCredentialSecret | null;
}

export interface AssetWorkflowsRepositoryContext {
  db: RepositoryDbClient;
}

export interface AssetWorkflowsRepository {
  createWorkflow(input: CreateAssetWorkflowInput): Promise<AssetWorkflowRow | null>;
  updateWorkflow(input: UpdateAssetWorkflowInput): Promise<AssetWorkflowRow | null>;
  // Soft delete (keeps the rule's execution history; hard DELETE would cascade).
  // Returns false when the rule doesn't exist or is already deleted.
  // The rule's own signing key is orphaned the moment this commits, so its retirement is
  // recorded by the same transaction — from the row's current value, read under lock. See
  // UpdateAssetWorkflowInput.
  deleteWorkflow(params: {
    workflowId: string;
    organizationId: string;
    projectId: string;
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
