/**
 * The only API implementation boundary consumed by @sdp/api-integration.
 * Keep this facade intentionally small and integration-test specific.
 */
import { hashString } from "@sdp/payments/hash";

import { closeDatabasePools, getDb } from "@/db";
import app from "@/index";
import { createKVStoreSet } from "@/runtime/factory";
import { closeAllRedisClients } from "@/runtime/kv-redis";
import { createFeePaymentAdapter, KoraAdapter, KoraClient } from "@/services/adapters";
import { createSigningService } from "@/services/domain/signing.service";
import { createMosaicService } from "@/services/mosaic";
import { createOrgSigner, createToken2022Service } from "@/services/solana";
import { CustodyConfigStore, type CustodyWallet } from "@/services/stores/custody-config.store";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import {
  TEST_PROJECT,
  TEST_PROJECT_API_KEY,
  TEST_PROJECT_CACHED_KEY,
} from "@/test/fixtures/tokens";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";
import type { Env } from "@/types/env";

export type ApiTestEnv = Env;
export type ApiTestCustodyWallet = CustodyWallet;

export const apiTestSupport = {
  app,
  clearTestDatabase,
  closeAllRedisClients,
  closeDatabasePools,
  createFeePaymentAdapter,
  createKVStoreSet,
  createMosaicService,
  createOrgSigner,
  createSigningService,
  createToken2022Service,
  CustodyConfigStore,
  getDb,
  hashString,
  KoraAdapter,
  KoraClient,
  seedTestDatabase,
  TEST_ORG,
  TEST_PROJECT,
  TEST_PROJECT_API_KEY,
  TEST_PROJECT_CACHED_KEY,
  TEST_USER,
};
