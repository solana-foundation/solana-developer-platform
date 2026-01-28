/**
 * Auth Routes
 */

import type { Env } from "@/types/env";
import { Hono } from "hono";
import { sendMagicLink, verifyMagicLink } from "./handlers/magic-link";
import {
  getCurrentUser,
  listSessions,
  logout,
  requireSession,
  revokeSession,
} from "./handlers/sessions";

const auth = new Hono<{ Bindings: Env }>();

// Magic link flow
auth.post("/magic-link", sendMagicLink);
auth.get("/magic-link/verify", verifyMagicLink);

// Session-protected routes
auth.post("/logout", requireSession(), logout);
auth.get("/me", requireSession(), getCurrentUser);
auth.get("/sessions", requireSession(), listSessions);
auth.delete("/sessions/:sessionId", requireSession(), revokeSession);

export default auth;
