import type { Context } from "hono";
import { AppError } from "@/lib/errors";
import type { Env } from "@/types/env";

export type AppContext = Context<{ Bindings: Env }>;

export function resolveActor(c: AppContext): { organizationId: string } {
  const apiKey = c.get("apiKey");
  if (apiKey) {
    return { organizationId: apiKey.organizationId };
  }

  const clerk = c.get("clerk");
  if (clerk) {
    return { organizationId: clerk.organizationId };
  }

  const replayActor = c.get("approvedOperationActor");
  if (replayActor) {
    return { organizationId: replayActor.organizationId };
  }

  throw new AppError("UNAUTHORIZED", "Authentication required");
}

export function parseBooleanQueryParam(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}
