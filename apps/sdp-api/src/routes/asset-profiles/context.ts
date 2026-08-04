import type { Context } from "hono";
import { createAssetProfilesRepository, createTokenRepository } from "@/db/repositories";
import { getRequestTenantScope } from "@/lib/tenant-scope";
import type { Env } from "@/types/env";

export type AppContext = Context<{ Bindings: Env }>;

export function getAssetProfilesRepository(c: AppContext) {
  return createAssetProfilesRepository(c.env, getRequestTenantScope(c));
}

export function getTokenRepository(c: AppContext) {
  return createTokenRepository(c.env, getRequestTenantScope(c));
}
