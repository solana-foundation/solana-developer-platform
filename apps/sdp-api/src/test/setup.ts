import { afterAll } from "vitest";
import { closeDatabasePools } from "@/db";

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
