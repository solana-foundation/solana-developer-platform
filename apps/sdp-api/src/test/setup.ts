import { closeDatabasePools } from "@/db";
import { env as providedEnv } from "cloudflare:test";
import { afterAll } from "vitest";

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
  await closeDatabasePools();
});
