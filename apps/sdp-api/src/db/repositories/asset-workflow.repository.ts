import type {
  ReviewMode,
  WorkflowActionType,
  WorkflowCondition,
  WorkflowRetryPolicy,
  WorkflowRuleAction,
  WorkflowTriggerType,
} from "@sdp/types";
import type { RepositoryDbClient } from "./base";

export function generateAssetWorkflowId(): string {
  return `asset_workflow_${crypto.randomUUID()}`;
}

// Stored under asset_workflows.definition JSONB.
export interface AssetWorkflowDefinition {
  condition: WorkflowCondition | null;
  action: WorkflowRuleAction;
  retryPolicy: WorkflowRetryPolicy;
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
}

export interface CreateAssetWorkflowInput {
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
}

export interface UpdateAssetWorkflowInput {
  workflowId: string;
  organizationId: string;
  projectId: string;
  definition?: AssetWorkflowDefinition;
  reviewMode?: ReviewMode;
  enabled?: boolean;
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
  }): Promise<boolean>;
  getWorkflowById(params: {
    workflowId: string;
    organizationId: string;
    projectId: string;
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
