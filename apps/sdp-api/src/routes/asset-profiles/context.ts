import type { Context } from "hono";
import { createAssetProfilesRepository, createTokenRepository } from "@/db/repositories";
import type { Env } from "@/types/env";

export type AppContext = Context<{ Bindings: Env }>;

export function getAssetProfilesRepository(c: AppContext) {
  return createAssetProfilesRepository(c.env);
}

export function getTokenRepository(c: AppContext) {
  return createTokenRepository(c.env);
}
