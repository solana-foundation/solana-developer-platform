import { getDb } from "@/db";
import type { Env } from "@/types/env";
import type { PaymentsRepository } from "./payments.repository";
import { createPostgresPaymentsRepository } from "./payments.repository.postgres";
import type { TokenRepository } from "./token.repository";
import { createPostgresTokenRepository } from "./token.repository.postgres";

export function createPaymentsRepository(env: Env): PaymentsRepository {
  return createPostgresPaymentsRepository(getDb(env));
}

export function createTokenRepository(env: Env): TokenRepository {
  return createPostgresTokenRepository(getDb(env));
}
