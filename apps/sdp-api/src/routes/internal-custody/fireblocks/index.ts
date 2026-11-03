import { Hono } from "hono";
import { authorize } from "@/middleware/authorize";
import { idempotent } from "@/middleware/idempotency";
import { requireAction } from "@/middleware/require-action";
import { validateBody } from "@/middleware/validate";
import { admitFireblocksRegistration } from "@/services/custody/fireblocks-registration.service";
import type { Env } from "@/types/env";
import { createCsr, discoverVaults, getCsr } from "./handlers";
import { createFireblocksCsrSchema } from "./schemas";

// Credential-admin authentication and project context are inherited from custody.
export const fireblocksCustody = new Hono<{ Bindings: Env }>();
fireblocksCustody.get("/csr", requireAction("wallets.configure"), getCsr);
fireblocksCustody.post(
  "/csr",
  requireAction("wallets.configure"),
  validateBody(createFireblocksCsrSchema),
  authorize((c) => admitFireblocksRegistration(c)),
  idempotent({ key: "required", serverErrors: "rerun" }),
  createCsr
);
// Credentials are POSTed to avoid placing API user IDs in URLs or access logs.
fireblocksCustody.post("/vaults", requireAction("wallets.configure"), discoverVaults);
