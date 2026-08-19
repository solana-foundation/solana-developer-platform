import { Hono, type Next } from "hono";
import { AppError } from "@/lib/errors";
import { isAssetProfilesEnabled } from "@/lib/feature-flags";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { policyGate } from "@/middleware/policy-gate";
import { projectContextMiddleware } from "@/middleware/project-context";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import {
  addAllowlistEntry,
  listAllowlist,
  listAllowlistLabels,
  removeAllowlistEntry,
} from "./handlers/allowlist";
import { getAssetAuditHistory } from "./handlers/audit";
import {
  executeUpdateAuthority,
  extractUpdateAuthorityPolicyCandidate,
  prepareUpdateAuthority,
} from "./handlers/authority";
import { executeBurn, prepareBurn } from "./handlers/burn";
import {
  confirmDeploy,
  deployToken,
  prepareDeploy,
  prepareDeployMetadata,
} from "./handlers/deploy";
import { executeForceBurn, prepareForceBurn } from "./handlers/force-burn";
import { freezeAccount, listFrozenAccounts, unfreezeAccount } from "./handlers/freeze";
import { enrollHolder, enrollHolderSchema, listHolders } from "./handlers/holders";
import { serveTokenMetadata } from "./handlers/metadata";
import { executeMint, extractMintPolicyCandidate, prepareMint } from "./handlers/mint";
import { pauseToken, unpauseToken } from "./handlers/pause";
import { executeSeize, prepareSeize } from "./handlers/seize";
import { refreshTokenSupply } from "./handlers/supply";
import { getTokenTemplate, listTokenTemplates } from "./handlers/templates";
import { createToken, getToken, listTokenFacets, listTokens, updateToken } from "./handlers/tokens";
import { listTokenTransactions, listTransactions } from "./handlers/transactions";
import {
  approveWorkflowExecution,
  cancelWorkflowExecution,
  listWorkflowExecutions,
  retryWorkflowExecution,
} from "./handlers/workflow-executions";
import {
  createWorkflow,
  createWorkflowSchema,
  deleteWorkflow,
  listWorkflowCatalog,
  listWorkflows,
  updateWorkflow,
  updateWorkflowSchema,
} from "./handlers/workflows";
import type { AppContext } from "./helpers";
import {
  addAllowlistSchema,
  burnSchema,
  confirmDeploySchema,
  createTokenSchema,
  deployTokenSchema,
  forceBurnSchema,
  freezeSchema,
  mintSchema,
  pauseTokenSchema,
  seizeSchema,
  unfreezeSchema,
  updateAuthoritySchema,
  updateTokenSchema,
} from "./schemas";

const issuance = new Hono<{ Bindings: Env }>();

// Public: SDP-hosted token metadata JSON. Registered BEFORE the auth middleware
// below so wallets and explorers can fetch it without credentials (Hono applies
// `use(...)` only to routes registered after it). App-wide KV/rate-limit bypass
// for this path is wired via KV_FREE_PATHS in app.ts.
issuance.get("/tokens/:tokenId/metadata.json", serveTokenMetadata);

issuance.use("*", unifiedAuthMiddleware({ allowClerk: true, allowSession: true }));
issuance.use("*", projectContextMiddleware());

// Templates (read-only, any authenticated user can view)
issuance.get("/templates", requirePermissions("tokens:read"), listTokenTemplates);
issuance.get("/templates/:templateId", requirePermissions("tokens:read"), getTokenTemplate);

// Token CRUD
issuance.post(
  "/tokens",
  requirePermissions("tokens:write"),
  validateBody(createTokenSchema),
  createToken
);
issuance.get("/tokens", requirePermissions("tokens:read"), listTokens);
issuance.get("/transactions", requirePermissions("tokens:read"), listTransactions);
// Filter facets for the token list. Registered BEFORE `/tokens/:tokenId` so the
// literal path wins the match instead of being read as a token id.
issuance.get("/tokens/facets", requirePermissions("tokens:read"), listTokenFacets);
issuance.get("/tokens/:tokenId", requirePermissions("tokens:read"), getToken);
issuance.get(
  "/tokens/:tokenId/transactions",
  requirePermissions("tokens:read"),
  listTokenTransactions
);
issuance.get("/tokens/:tokenId/audit", requirePermissions("tokens:read"), getAssetAuditHistory);
issuance.post(
  "/tokens/:tokenId/supply/refresh",
  requirePermissions("tokens:read"),
  refreshTokenSupply
);
issuance.patch(
  "/tokens/:tokenId",
  requirePermissions("tokens:write"),
  validateBody(updateTokenSchema),
  updateToken
);

// Deploy
issuance.post(
  "/tokens/:tokenId/deploy",
  requirePermissions("tokens:write"),
  validateBody(deployTokenSchema),
  deployToken
);
issuance.post(
  "/tokens/:tokenId/deploy/prepare",
  requirePermissions("tokens:write"),
  validateBody(deployTokenSchema),
  prepareDeploy
);
// Confirmation step for the non-custodial deploy flow: records the mint after
// the client signs+submits the prepared create tx. Re-derives authorities from
// the signing wallet prepareDeploy persisted on the token, so they can't diverge
// from the prepared tx. Required before prepare-metadata can run.
issuance.post(
  "/tokens/:tokenId/deploy/confirm",
  requirePermissions("tokens:write"),
  validateBody(confirmDeploySchema),
  confirmDeploy
);
// Follow-up tx for the non-custodial deploy flow: set the metadata uri when the
// create tx had to be prepared with an empty uri to stay under the packet limit.
issuance.post(
  "/tokens/:tokenId/deploy/prepare-metadata",
  requirePermissions("tokens:write"),
  validateBody(deployTokenSchema),
  prepareDeployMetadata
);

// Mint
issuance.post(
  "/tokens/:tokenId/mint/prepare",
  requirePermissions("tokens:write"),
  validateBody(mintSchema),
  prepareMint
);
issuance.post(
  "/tokens/:tokenId/mint",
  requirePermissions("tokens:write"),
  validateBody(mintSchema),
  policyGate({ extract: extractMintPolicyCandidate }),
  executeMint
);

// Burn
issuance.post(
  "/tokens/:tokenId/burn/prepare",
  requirePermissions("tokens:write"),
  validateBody(burnSchema),
  prepareBurn
);
issuance.post(
  "/tokens/:tokenId/burn",
  requirePermissions("tokens:write"),
  validateBody(burnSchema),
  executeBurn
);

// Seize (Force Transfer)
issuance.post(
  "/tokens/:tokenId/seize/prepare",
  requirePermissions("tokens:admin"),
  validateBody(seizeSchema),
  prepareSeize
);
issuance.post(
  "/tokens/:tokenId/seize",
  requirePermissions("tokens:admin"),
  validateBody(seizeSchema),
  executeSeize
);

// Force Burn
issuance.post(
  "/tokens/:tokenId/force-burn/prepare",
  requirePermissions("tokens:admin"),
  validateBody(forceBurnSchema),
  prepareForceBurn
);
issuance.post(
  "/tokens/:tokenId/force-burn",
  requirePermissions("tokens:admin"),
  validateBody(forceBurnSchema),
  executeForceBurn
);

// Authority Updates
issuance.post(
  "/tokens/:tokenId/authority/prepare",
  requirePermissions("tokens:admin"),
  validateBody(updateAuthoritySchema),
  prepareUpdateAuthority
);
issuance.post(
  "/tokens/:tokenId/authority",
  requirePermissions("tokens:admin"),
  validateBody(updateAuthoritySchema),
  policyGate({ extract: extractUpdateAuthorityPolicyCandidate }),
  executeUpdateAuthority
);

// Pause/Unpause
issuance.post(
  "/tokens/:tokenId/pause",
  requirePermissions("tokens:admin"),
  validateBody(pauseTokenSchema),
  pauseToken
);
issuance.post(
  "/tokens/:tokenId/unpause",
  requirePermissions("tokens:admin"),
  validateBody(pauseTokenSchema),
  unpauseToken
);

// Freeze/Unfreeze
issuance.post(
  "/tokens/:tokenId/freeze",
  requirePermissions("tokens:admin"),
  validateBody(freezeSchema),
  freezeAccount
);
issuance.post(
  "/tokens/:tokenId/unfreeze",
  requirePermissions("tokens:admin"),
  validateBody(unfreezeSchema),
  unfreezeAccount
);
issuance.get("/tokens/:tokenId/frozen", requirePermissions("tokens:read"), listFrozenAccounts);

// Allowlist
// `/allowlist/labels` (GET) is registered before the `/allowlist/:entryId`
// (DELETE) route; distinct methods mean there is no path collision either way.
issuance.get(
  "/tokens/:tokenId/allowlist/labels",
  requirePermissions("tokens:read"),
  listAllowlistLabels
);
issuance.get("/tokens/:tokenId/allowlist", requirePermissions("tokens:read"), listAllowlist);
issuance.post(
  "/tokens/:tokenId/allowlist",
  requirePermissions("tokens:write"),
  validateBody(addAllowlistSchema),
  addAllowlistEntry
);
issuance.delete(
  "/tokens/:tokenId/allowlist/:entryId",
  requirePermissions("tokens:write"),
  removeAllowlistEntry
);

// Holders + workflows are the asset-profiles feature surface, and the cron that drains
// workflow executions is itself flag-gated. Leaving the enqueue side open while the
// drain side is off would let a flag-off deployment silently accumulate a backlog that
// detonates against weeks-old payloads the moment the flag flips.
async function requireAssetProfilesFeature(c: AppContext, next: Next) {
  if (!isAssetProfilesEnabled(c.env)) {
    throw new AppError("FORBIDDEN", "Asset Profiles are not enabled for this environment");
  }
  await next();
}

// Holders (KYC-wallet enrollment for an asset)
issuance.get(
  "/tokens/:tokenId/holders",
  requireAssetProfilesFeature,
  requirePermissions("tokens:read"),
  listHolders
);
issuance.post(
  "/tokens/:tokenId/holders",
  requireAssetProfilesFeature,
  requirePermissions("tokens:write"),
  validateBody(enrollHolderSchema),
  enrollHolder
);

issuance.use("/tokens/:tokenId/workflows", requireAssetProfilesFeature);
issuance.use("/tokens/:tokenId/workflows/*", requireAssetProfilesFeature);

// Workflow builder — catalog + rules (register static paths before :workflowId)
issuance.get(
  "/tokens/:tokenId/workflows/catalog",
  requirePermissions("tokens:read"),
  listWorkflowCatalog
);
issuance.get(
  "/tokens/:tokenId/workflows/executions",
  requirePermissions("tokens:read"),
  listWorkflowExecutions
);
// Decisions and rule writes carry `tokens:write` as the floor; the handler then raises
// the bar to `tokens:admin` for any rule whose action tier is sensitive or irreversible
// (see workflow-authz.ts). Without that second check, workflows would be a way around
// the `tokens:admin` the direct seize/freeze/pause routes require.
issuance.post(
  "/tokens/:tokenId/workflows/executions/:executionId/approve",
  requirePermissions("tokens:write"),
  approveWorkflowExecution
);
issuance.post(
  "/tokens/:tokenId/workflows/executions/:executionId/retry",
  requirePermissions("tokens:write"),
  retryWorkflowExecution
);
issuance.post(
  "/tokens/:tokenId/workflows/executions/:executionId/reject",
  requirePermissions("tokens:write"),
  cancelWorkflowExecution
);
issuance.get("/tokens/:tokenId/workflows", requirePermissions("tokens:read"), listWorkflows);
issuance.post(
  "/tokens/:tokenId/workflows",
  requirePermissions("tokens:write"),
  validateBody(createWorkflowSchema),
  createWorkflow
);
issuance.patch(
  "/tokens/:tokenId/workflows/:workflowId",
  requirePermissions("tokens:write"),
  validateBody(updateWorkflowSchema),
  updateWorkflow
);
issuance.delete(
  "/tokens/:tokenId/workflows/:workflowId",
  requirePermissions("tokens:write"),
  deleteWorkflow
);

export default issuance;
