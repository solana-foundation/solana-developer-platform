/**
 * Auth Routes
 */

import { Hono } from "hono";
import type { Env } from "@/types/env";
import {
  getCurrentUser,
  listSessions,
  logout,
  requireSession,
  revokeSession,
} from "./handlers/sessions";

const auth = new Hono<{ Bindings: Env }>();

// Session-protected routes
auth.post("/logout", requireSession(), logout);
auth.get("/me", requireSession(), getCurrentUser);
auth.get("/sessions", requireSession(), listSessions);
auth.delete("/sessions/:sessionId", requireSession(), revokeSession);

export default auth;
