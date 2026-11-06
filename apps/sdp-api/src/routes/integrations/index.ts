import { Hono } from "hono";
import { unifiedAuthMiddleware } from "@/middleware/auth";
import { projectContextMiddleware } from "@/middleware/project-context";
import { requireAction } from "@/middleware/require-action";
import type { Env } from "@/types/env";
import { getIntegrationsHandler } from "./handlers";

export const integrations = new Hono<{ Bindings: Env }>();

integrations.use("*", unifiedAuthMiddleware());
integrations.use("*", projectContextMiddleware());
integrations.get("/", requireAction("projects.read"), getIntegrationsHandler);
