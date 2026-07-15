import { Hono } from "hono";
import { unifiedAuthMiddleware } from "@/middleware/auth";
import { projectContextMiddleware } from "@/middleware/project-context";
import type { Env } from "@/types/env";
import { listPolicyControlInventory } from "./handlers";

const policies = new Hono<{ Bindings: Env }>();

policies.use("*", unifiedAuthMiddleware({ allowClerk: true, allowSession: true }));
policies.use("*", projectContextMiddleware());
policies.get("/", listPolicyControlInventory);

export default policies;
