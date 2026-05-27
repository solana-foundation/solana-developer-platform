/**
 * Issuance Routes
 */

import { Hono } from "hono";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { projectContextMiddleware } from "@/middleware/project-context";
import type { Env } from "@/types/env";
import { addAllowlistEntry, listAllowlist, removeAllowlistEntry } from "./handlers/allowlist";
import { executeUpdateAuthority, prepareUpdateAuthority } from "./handlers/authority";
import { executeBurn, prepareBurn } from "./handlers/burn";
import { deployToken, prepareDeploy } from "./handlers/deploy";
import { executeForceBurn, prepareForceBurn } from "./handlers/force-burn";
import { freezeAccount, listFrozenAccounts, unfreezeAccount } from "./handlers/freeze";
import { executeMint, prepareMint } from "./handlers/mint";
import { pauseToken, unpauseToken } from "./handlers/pause";
import { executeSeize, prepareSeize } from "./handlers/seize";
import { refreshTokenSupply } from "./handlers/supply";
import { getTokenTemplate, listTokenTemplates } from "./handlers/templates";
import { createToken, getToken, listTokens, updateToken } from "./handlers/tokens";
import { listTokenTransactions, listTransactions } from "./handlers/transactions";

const issuance = new Hono<{ Bindings: Env }>();

// All routes require authentication
issuance.use("*", unifiedAuthMiddleware({ allowClerk: true, allowSession: true }));
issuance.use("*", projectContextMiddleware());

// Templates (read-only, any authenticated user can view)
issuance.get("/templates", requirePermissions("tokens:read"), listTokenTemplates);
issuance.get("/templates/:templateId", requirePermissions("tokens:read"), getTokenTemplate);

// Token CRUD
issuance.post("/tokens", requirePermissions("tokens:write"), createToken);
issuance.get("/tokens", requirePermissions("tokens:read"), listTokens);
issuance.get("/transactions", requirePermissions("tokens:read"), listTransactions);
issuance.get("/tokens/:tokenId", requirePermissions("tokens:read"), getToken);
issuance.get(
  "/tokens/:tokenId/transactions",
  requirePermissions("tokens:read"),
  listTokenTransactions
);
issuance.post(
  "/tokens/:tokenId/supply/refresh",
  requirePermissions("tokens:read"),
  refreshTokenSupply
);
issuance.patch("/tokens/:tokenId", requirePermissions("tokens:write"), updateToken);

// Deploy
issuance.post("/tokens/:tokenId/deploy", requirePermissions("tokens:write"), deployToken);
issuance.post("/tokens/:tokenId/deploy/prepare", requirePermissions("tokens:write"), prepareDeploy);

// Mint
issuance.post("/tokens/:tokenId/mint/prepare", requirePermissions("tokens:write"), prepareMint);
issuance.post("/tokens/:tokenId/mint", requirePermissions("tokens:write"), executeMint);

// Burn
issuance.post("/tokens/:tokenId/burn/prepare", requirePermissions("tokens:write"), prepareBurn);
issuance.post("/tokens/:tokenId/burn", requirePermissions("tokens:write"), executeBurn);

// Seize (Force Transfer)
issuance.post("/tokens/:tokenId/seize/prepare", requirePermissions("tokens:admin"), prepareSeize);
issuance.post("/tokens/:tokenId/seize", requirePermissions("tokens:admin"), executeSeize);

// Force Burn
issuance.post(
  "/tokens/:tokenId/force-burn/prepare",
  requirePermissions("tokens:admin"),
  prepareForceBurn
);
issuance.post("/tokens/:tokenId/force-burn", requirePermissions("tokens:admin"), executeForceBurn);

// Authority Updates
issuance.post(
  "/tokens/:tokenId/authority/prepare",
  requirePermissions("tokens:admin"),
  prepareUpdateAuthority
);
issuance.post(
  "/tokens/:tokenId/authority",
  requirePermissions("tokens:admin"),
  executeUpdateAuthority
);

// Pause/Unpause
issuance.post("/tokens/:tokenId/pause", requirePermissions("tokens:admin"), pauseToken);
issuance.post("/tokens/:tokenId/unpause", requirePermissions("tokens:admin"), unpauseToken);

// Freeze/Unfreeze
issuance.post("/tokens/:tokenId/freeze", requirePermissions("tokens:admin"), freezeAccount);
issuance.post("/tokens/:tokenId/unfreeze", requirePermissions("tokens:admin"), unfreezeAccount);
issuance.get("/tokens/:tokenId/frozen", requirePermissions("tokens:read"), listFrozenAccounts);

// Allowlist
issuance.get("/tokens/:tokenId/allowlist", requirePermissions("tokens:read"), listAllowlist);
issuance.post("/tokens/:tokenId/allowlist", requirePermissions("tokens:write"), addAllowlistEntry);
issuance.delete(
  "/tokens/:tokenId/allowlist/:entryId",
  requirePermissions("tokens:write"),
  removeAllowlistEntry
);

export default issuance;
