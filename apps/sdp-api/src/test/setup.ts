import { afterAll } from "vitest";
import { closeDatabasePools } from "@/db";
import { setDefaultDatabaseIdentityForTesting } from "@/db/identity";
import { closeAllRedisClients } from "@/runtime/kv-redis";

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

afterAll(async () => {
  await Promise.all([closeDatabasePools(), closeAllRedisClients()]);
});
