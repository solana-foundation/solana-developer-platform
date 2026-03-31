import { closeDatabasePools } from "@sdp/api/db";
import { afterAll } from "vitest";
import { ensureIntegrationPreflight } from "./helpers/preflight";

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

// Fail fast when running integration tests in CI: validate Kora + Solana RPC
// connectivity and basic funding assumptions before any test files are evaluated.
await ensureIntegrationPreflight();

afterAll(async () => {
  await closeDatabasePools();
});
