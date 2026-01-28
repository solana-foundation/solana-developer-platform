/**
 * Issuance Routes
 */

import { authMiddleware, requirePermissions } from "@/middleware/auth";
import type { Env } from "@/types/env";
import { Hono } from "hono";
import { addAllowlistEntry, listAllowlist, removeAllowlistEntry } from "./handlers/allowlist";
import { executeBurn, prepareBurn } from "./handlers/burn";
import { deployToken, prepareDeploy } from "./handlers/deploy";
import { freezeAccount, unfreezeAccount } from "./handlers/freeze";
import { executeMint, prepareMint } from "./handlers/mint";
import { createToken, getToken, listTokens, updateToken } from "./handlers/tokens";

const issuance = new Hono<{ Bindings: Env }>();

// All routes require authentication
issuance.use("*", authMiddleware());

// Token CRUD
issuance.post("/tokens", requirePermissions("tokens:write"), createToken);
issuance.get("/tokens", requirePermissions("tokens:read"), listTokens);
issuance.get("/tokens/:tokenId", requirePermissions("tokens:read"), getToken);
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

// Freeze/Unfreeze
issuance.post("/tokens/:tokenId/freeze", requirePermissions("tokens:admin"), freezeAccount);
issuance.post("/tokens/:tokenId/unfreeze", requirePermissions("tokens:admin"), unfreezeAccount);

// Allowlist
issuance.get("/tokens/:tokenId/allowlist", requirePermissions("tokens:read"), listAllowlist);
issuance.post("/tokens/:tokenId/allowlist", requirePermissions("tokens:write"), addAllowlistEntry);
issuance.delete(
  "/tokens/:tokenId/allowlist/:entryId",
  requirePermissions("tokens:write"),
  removeAllowlistEntry
);

export default issuance;
