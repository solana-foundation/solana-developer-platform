import { HeliusRingsError } from "@sdp/helius-rings";
import type { Context } from "hono";
import {
  createHeliusRingsOperationRepository,
  createHeliusRingsWalletRepository,
  createHeliusRingsZoneRepository,
} from "@/db/repositories";
import { AppError, type ErrorCode } from "@/lib/errors";
import { createHeliusRingsService } from "@/services/helius-rings";
import type { Env } from "@/types/env";

/** Hono request context bound to the app `Env`. */
export type AppContext = Context<{ Bindings: Env }>;

export function getHeliusRingsService(
  c: AppContext,
  tenant: { organizationId: string; projectId: string }
) {
  return createHeliusRingsService(c.env, tenant);
}

export function getHeliusRingsWalletRepository(c: AppContext) {
  return createHeliusRingsWalletRepository(c.env);
}

export function getHeliusRingsOperationRepository(c: AppContext) {
  return createHeliusRingsOperationRepository(c.env);
}

export function getHeliusRingsZoneRepository(c: AppContext) {
  return createHeliusRingsZoneRepository(c.env);
}

const RINGS_ERROR_CODES: Record<HeliusRingsError["code"], ErrorCode> = {
  invalid_input: "BAD_REQUEST",
  not_found: "NOT_FOUND",
  conflict: "CONFLICT",
  // 503 carrying the gateway's own reason, which is the only text naming what
  // refused.
  gateway_unavailable: "SERVICE_UNAVAILABLE",
  config_error: "SERVICE_UNAVAILABLE",
};

/** Path param, typed as present — the router only matches when it is. */
export function requireParam(c: AppContext, name: string): string {
  const value = c.req.param(name);
  if (!value) throw new AppError("BAD_REQUEST", `missing ${name}`);
  return value;
}

/** Runs a handler body, translating domain errors to API errors. */
export async function withRingsErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof HeliusRingsError) {
      throw new AppError(RINGS_ERROR_CODES[error.code], error.message);
    }
    throw error;
  }
}
