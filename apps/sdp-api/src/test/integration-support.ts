/**
 * The only API implementation boundary consumed by @sdp/api-integration.
 * Keep this facade intentionally small and integration-test specific.
 */

import { supportsVaultDirect } from "@sdp/earn/capabilities";
import { createFeePaymentAdapter, KoraAdapter, KoraClient } from "@sdp/payments/fee-payment";
import { hashString } from "@sdp/payments/hash";
import { EARN_PROVIDERS } from "@sdp/types/provider-access";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { closeDatabasePools, getDb } from "@/db";
import { SponsorshipBudgetRepository } from "@/db/repositories/sponsorship-budget.repository";
import app from "@/index";
import { closeAllRedisClients, createKVStoreSet } from "@/runtime/kv-redis";
import { createSigningService } from "@/services/domain/signing.service";
import { resolveEarnExecutionClient } from "@/services/earn/execution-registry";
import { createVaultDeadline } from "@/services/earn/vault-deadline";
import { createMosaicService } from "@/services/issuance/mosaic";
import { trackPendingTransfers } from "@/services/jobs/track-pending-transfers";
import { createOrgSigner, createToken2022Service } from "@/services/solana";
import { CustodyConfigStore, type CustodyWallet } from "@/services/stores/custody-config.store";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import {
  TEST_PROJECT,
  TEST_PROJECT_API_KEY,
  TEST_PROJECT_CACHED_KEY,
} from "@/test/fixtures/tokens";
import { seedTestDatabase } from "@/test/mocks/db";
import type { Env } from "@/types/env";

export type ApiTestEnv = Env;
export type ApiTestCustodyWallet = CustodyWallet;

export const apiTestSupport = {
  app,
  closeAllRedisClients,
  closeDatabasePools,
  createFeePaymentAdapter,
  createKVStoreSet,
  createMosaicService,
  createOrgSigner,
  createSigningService,
  createToken2022Service,
  createVaultDeadline,
  CustodyConfigStore,
  EARN_PROVIDERS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getDb,
  hashString,
  KoraAdapter,
  KoraClient,
  resolveEarnExecutionClient,
  seedTestDatabase,
  supportsVaultDirect,
  TOKEN_PROGRAM_ADDRESS,
  SponsorshipBudgetRepository,
  TEST_ORG,
  TEST_PROJECT,
  TEST_PROJECT_API_KEY,
  TEST_PROJECT_CACHED_KEY,
  TEST_USER,
  trackPendingTransfers,
};
