/**
 * Allowlist Management Routes (Internal Admin)
 */

import { Hono } from "hono";
import { unifiedAuthMiddleware } from "@/middleware/auth";
import { projectContextMiddleware } from "@/middleware/project-context";
import type { Env } from "@/types/env";
import { addEntry, listEntries, removeEntry } from "./handlers";
import { adminAuth } from "./middleware";

const allowlist = new Hono<{ Bindings: Env }>();

allowlist.use("*", unifiedAuthMiddleware({ allowClerk: true, allowSession: true }));
allowlist.use("*", projectContextMiddleware());
allowlist.use("*", adminAuth);

allowlist.get("/", listEntries);
allowlist.post("/", addEntry);
allowlist.delete("/:id", removeEntry);

export default allowlist;
