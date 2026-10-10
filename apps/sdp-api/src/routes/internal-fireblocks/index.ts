import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { badRequest } from "@/lib/errors";
import { success } from "@/lib/response";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { credentialAdminAuthMiddleware } from "@/middleware/credential-admin-auth";
import { enforceMeteredQuota } from "@/middleware/metered-quota";
import { projectContextMiddleware } from "@/middleware/project-context";
import {
  checkFireblocksDestination,
  requestFireblocksWhitelist,
} from "@/services/custody/fireblocks-address-book.service";
import {
  checkFireblocksPolicy,
  getFireblocksPolicySetup,
  saveFireblocksPolicyDraft,
  submitFireblocksPolicyDraft,
} from "@/services/custody/fireblocks-policy.service";
import type { Env } from "@/types/env";

const input = z
  .object({
    walletId: z.string().min(1).max(200),
    counterpartyId: z.string().min(1).max(200),
    accountId: z.string().min(1).max(200),
    address: z.string().min(32).max(44),
    token: z.string().min(1).max(64),
  })
  .strict();
const routes = new Hono<{ Bindings: Env }>();
const policySelection = input.extend({
  amount: z
    .string()
    .max(100)
    .regex(/^\d+(\.\d+)?$/),
});
const ids = z
  .array(z.string().min(1).max(100))
  .max(50)
  .refine((values) => new Set(values).size === values.length);
const policyForm = z
  .object({
    name: z.string().trim().min(1).max(200).startsWith("Created within SDP — "),
    destination: z.enum(["all_whitelisted", "selected_whitelisted", "one_time"]),
    approvalGroups: z
      .array(
        z.object({ users: ids, groups: ids, threshold: z.number().int().min(1).max(100) }).strict()
      )
      .min(1)
      .max(5),
    approvalOperator: z.enum(["AND", "OR"]),
    signerMode: z.enum(["SINGLE", "MULTIPLE"]),
    signerIds: ids.min(1),
  })
  .strict();
routes.use("*", bodyLimit({ maxSize: 4096 }));
routes.use("*", unifiedAuthMiddleware());
routes.use("*", projectContextMiddleware());
routes.use("*", requirePermissions("wallets:read", "counterparties:read"));
routes.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});
routes.get("/destination", async (c) => {
  const parsed = input.safeParse(c.req.query());
  if (!parsed.success) throw badRequest("Invalid Fireblocks destination");
  await enforceMeteredQuota(c, { name: "fireblocks-destination", actorMax: 60, orgMax: 300 });
  return success(c, await checkFireblocksDestination(c, parsed.data));
});
routes.post("/whitelist", requirePermissions("counterparties:write"), async (c) => {
  const parsed = input.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw badRequest("Invalid Fireblocks destination");
  await enforceMeteredQuota(c, { name: "fireblocks-whitelist", actorMax: 10, orgMax: 30 });
  return success(c, await requestFireblocksWhitelist(c, parsed.data));
});
routes.get("/policy", async (c) => {
  const parsed = policySelection.safeParse(c.req.query());
  if (!parsed.success) throw badRequest("Invalid Fireblocks payment selection");
  await enforceMeteredQuota(c, { name: "fireblocks-policy-check", actorMax: 60, orgMax: 300 });
  return success(c, await checkFireblocksPolicy(c, parsed.data));
});
routes.use("/policy/*", credentialAdminAuthMiddleware());
routes.get("/policy/setup", async (c) => {
  const parsed = policySelection.safeParse(c.req.query());
  if (!parsed.success) throw badRequest("Invalid Fireblocks payment selection");
  await enforceMeteredQuota(c, { name: "fireblocks-policy-setup", actorMax: 15, orgMax: 60 });
  return success(c, await getFireblocksPolicySetup(c, parsed.data));
});
routes.post("/policy/draft", async (c) => {
  const parsed = z
    .object({
      selection: policySelection,
      form: policyForm,
      revision: z.string().regex(/^[a-f0-9]{64}$/),
      requestId: z.string().uuid(),
    })
    .strict()
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw badRequest("Invalid Fireblocks transfer rule");
  await enforceMeteredQuota(c, { name: "fireblocks-policy-write", actorMax: 5, orgMax: 20 });
  return success(
    c,
    await saveFireblocksPolicyDraft(
      c,
      parsed.data.selection,
      parsed.data.form,
      parsed.data.revision,
      parsed.data.requestId
    )
  );
});
routes.post("/policy/publish", async (c) => {
  const parsed = z
    .object({ selection: policySelection, proposalId: z.string().min(1).max(100) })
    .strict()
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw badRequest("Invalid Fireblocks policy proposal");
  await enforceMeteredQuota(c, { name: "fireblocks-policy-publish", actorMax: 5, orgMax: 20 });
  return success(
    c,
    await submitFireblocksPolicyDraft(c, parsed.data.selection, parsed.data.proposalId)
  );
});
export default routes;
