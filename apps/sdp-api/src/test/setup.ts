import { afterAll, beforeEach } from "vitest";
import { closeDatabasePools } from "@/db/client";
import { setDefaultDatabaseIdentityForTesting } from "@/db/identity";
import { resetTerminalRefusalsForTesting } from "@/lib/api-key-refusal-cache";
import { closeAllRedisClients } from "@/runtime/kv-redis";
import { MANAGED_POOL_ENV_KEYS } from "@/test/helpers/managed-pool-env";

for (const envKey of MANAGED_POOL_ENV_KEYS) {
  process.env[envKey] = "";
}

// Fixtures and direct repository tests talk to the database outside any HTTP
// or worker entry point, so they get the privileged system identity by
// default. Requests through the app never fall back to this — the HTTP
// identity boundary pins an explicit identity (or explicitly none) first —
// so missing identity wiring still fails closed in integration tests.
setDefaultDatabaseIdentityForTesting({ kind: "system", component: "vitest" });

const globalWithSecureContext = globalThis as { isSecureContext?: boolean };

if (!globalWithSecureContext.isSecureContext) {
  try {
    Object.defineProperty(globalThis, "isSecureContext", {
      value: true,
      configurable: true,
    });
  } catch {
    globalWithSecureContext.isSecureContext = true;
  }
}

// Suites reuse key hashes across tests (a fixture key revoked in one test is
// active in the next), so each test starts with a cold refusal cache.
beforeEach(() => {
  resetTerminalRefusalsForTesting();
});

afterAll(async () => {
  await Promise.all([closeDatabasePools(), closeAllRedisClients()]);
});
