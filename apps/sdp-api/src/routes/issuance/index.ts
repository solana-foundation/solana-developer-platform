import { Hono, type Next } from "hono";
import { runWithSystemDatabaseIdentity } from "@/db";
import { AppError } from "@/lib/errors";
import { isAssetProfilesEnabled } from "@/lib/feature-flags";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { meteredQuota } from "@/middleware/metered-quota";
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
  admitUpdateAuthorityRuntimeExecution,
  executeUpdateAuthority,
  extractUpdateAuthorityPolicyCandidate,
  findUpdateAuthorityIdempotentKeyReplay,
  prepareUpdateAuthority,
} from "./handlers/authority";
import { executeBurn, extractBurnPolicyCandidate, prepareBurn } from "./handlers/burn";
import {
  confirmDeploy,
  deployToken,
  prepareDeploy,
  prepareDeployMetadata,
} from "./handlers/deploy";
import {
  executeForceBurn,
  extractForceBurnPolicyCandidate,
  prepareForceBurn,
} from "./handlers/force-burn";
import { freezeAccount, listFrozenAccounts, unfreezeAccount } from "./handlers/freeze";
import { enrollHolder, enrollHolderSchema, listHolders } from "./handlers/holders";
import { serveTokenMetadata } from "./handlers/metadata";
import {
  admitMintRuntimeExecution,
  executeMint,
  extractMintPolicyCandidate,
  findMintIdempotentKeyReplay,
  prepareMint,
} from "./handlers/mint";
import { pauseToken, unpauseToken } from "./handlers/pause";
import { executeSeize, extractSeizePolicyCandidate, prepareSeize } from "./handlers/seize";
import { refreshTokenSupply } from "./handlers/supply";
import { getTokenTemplate, listTokenTemplates } from "./handlers/templates";
import { createToken, getToken, listTokenFacets, listTokens, updateToken } from "./handlers/tokens";
import { listTokenTransactions, listTransactions } from "./handlers/transactions";
import type { AppContext } from "./helpers";
import {
  addAllowlistSchema,
  burnSchema,
  confirmDeploySchema,
  createTokenSchema,
  deployTokenSchema,
  forceBurnSchema,
  freezeSchema,
  legacyDeployTokenSchema,
  mintSchema,
  pauseTokenSchema,
  seizeSchema,
  unfreezeSchema,
  updateAuthoritySchema,
  updateTokenSchema,
} from "./schemas";

export const ISSUANCE_SUPPLY_QUOTA = { name: "issuance-supply", actorMax: 10, orgMax: 40 };
export const ISSUANCE_PREPARE_QUOTA = { name: "issuance-prepare", actorMax: 30, orgMax: 120 };

const issuance = new Hono<{ Bindings: Env }>();

// Public: SDP-hosted token metadata JSON. Registered BEFORE the auth middleware
// below so wallets and explorers can fetch it without credentials (Hono applies
// `use(...)` only to routes registered after it). App-wide KV/rate-limit bypass
// for this path is wired via KV_FREE_PATHS in app.ts.
// Public lookups resolve a token by id with no tenant in scope, so the
// handler runs under an explicit system database identity.
issuance.get("/tokens/:tokenId/metadata.json", (c) =>
  runWithSystemDatabaseIdentity("http:token-metadata", () => serveTokenMetadata(c))
);

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
  meteredQuota(ISSUANCE_SUPPLY_QUOTA),
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
  validateBody(legacyDeployTokenSchema),
  meteredQuota(ISSUANCE_PREPARE_QUOTA),
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
  validateBody(legacyDeployTokenSchema),
  meteredQuota(ISSUANCE_PREPARE_QUOTA),
  prepareDeployMetadata
);

// Mint
issuance.post(
  "/tokens/:tokenId/mint/prepare",
  requirePermissions("tokens:write"),
  validateBody(mintSchema),
  meteredQuota(ISSUANCE_PREPARE_QUOTA),
  prepareMint
);
issuance.post(
  "/tokens/:tokenId/mint",
  requirePermissions("tokens:write"),
  validateBody(mintSchema),
  policyGate({
    extract: extractMintPolicyCandidate,
    findIdempotentKeyReplay: findMintIdempotentKeyReplay,
    beforeEnforce: admitMintRuntimeExecution,
  }),
  executeMint
);

// Burn
issuance.post(
  "/tokens/:tokenId/burn/prepare",
  requirePermissions("tokens:write"),
  validateBody(burnSchema),
  meteredQuota(ISSUANCE_PREPARE_QUOTA),
  prepareBurn
);
issuance.post(
  "/tokens/:tokenId/burn",
  requirePermissions("tokens:write"),
  validateBody(burnSchema),
  policyGate({ extract: extractBurnPolicyCandidate }),
  executeBurn
);

// Seize (Force Transfer)
issuance.post(
  "/tokens/:tokenId/seize/prepare",
  requirePermissions("tokens:admin"),
  validateBody(seizeSchema),
  meteredQuota(ISSUANCE_PREPARE_QUOTA),
  prepareSeize
);
issuance.post(
  "/tokens/:tokenId/seize",
  requirePermissions("tokens:admin"),
  validateBody(seizeSchema),
  policyGate({ extract: extractSeizePolicyCandidate }),
  executeSeize
);

// Force Burn
issuance.post(
  "/tokens/:tokenId/force-burn/prepare",
  requirePermissions("tokens:admin"),
  validateBody(forceBurnSchema),
  meteredQuota(ISSUANCE_PREPARE_QUOTA),
  prepareForceBurn
);
issuance.post(
  "/tokens/:tokenId/force-burn",
  requirePermissions("tokens:admin"),
  validateBody(forceBurnSchema),
  policyGate({ extract: extractForceBurnPolicyCandidate }),
  executeForceBurn
);

// Authority Updates
issuance.post(
  "/tokens/:tokenId/authority/prepare",
  requirePermissions("tokens:admin"),
  validateBody(updateAuthoritySchema),
  meteredQuota(ISSUANCE_PREPARE_QUOTA),
  prepareUpdateAuthority
);
issuance.post(
  "/tokens/:tokenId/authority",
  requirePermissions("tokens:admin"),
  validateBody(updateAuthoritySchema),
  policyGate({
    extract: extractUpdateAuthorityPolicyCandidate,
    findIdempotentKeyReplay: findUpdateAuthorityIdempotentKeyReplay,
    beforeEnforce: admitUpdateAuthorityRuntimeExecution,
  }),
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

// Holders are the asset-profiles feature surface.
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

export default issuance;
