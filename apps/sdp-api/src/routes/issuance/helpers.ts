import { getAuth } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import type { Env } from "@/types/env";
import type { Context } from "hono";

type AppContext = Context<{ Bindings: Env }>;

export const requireProjectScope = (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = auth.projectId;

  if (!projectId) {
    throw new AppError("BAD_REQUEST", "Project-scoped API key required for token operations");
  }

  return { auth, projectId, orgId: auth.organizationId };
};
