import { apiTestSupport } from "@sdp/api/test-support";
import { afterAll } from "vitest";
import { ensureIntegrationPreflight } from "./helpers/preflight";

const { closeAllRedisClients, closeDatabasePools } = apiTestSupport;

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

// Fail fast when running integration tests in CI: validate the in-scope suites'
// connectivity and funding assumptions before any test files are evaluated. Scope
// comes from SDP_INTEGRATION_SUITE, or is inferred from configured env.
await ensureIntegrationPreflight();

afterAll(async () => {
  await Promise.all([closeDatabasePools(), closeAllRedisClients()]);
});
