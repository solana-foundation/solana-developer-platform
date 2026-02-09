/**
 * Custody Routes
 *
 * Manages organization-specific signing key configuration.
 * Enables per-org custody while maintaining backward compatibility with env-based signing.
 */

import { authMiddleware, requirePermissions } from "@/middleware/auth";
import type { Env } from "@/types/env";
import { Hono } from "hono";
import { createWallet, getConfig, getPublicKey, initializeSigning, listWallets } from "./handlers";

const custody = new Hono<{ Bindings: Env }>();

// All routes require authentication
custody.use("*", authMiddleware());

// Initialize signing (requires admin)
custody.post("/initialize", requirePermissions("custody:admin"), initializeSigning);
custody.post("/wallets", requirePermissions("custody:admin"), createWallet);

// Read configuration and wallets
custody.get("/config", requirePermissions("custody:read"), getConfig);
custody.get("/wallets", requirePermissions("custody:read"), listWallets);
custody.get("/public-key", requirePermissions("custody:read"), getPublicKey);

export default custody;
