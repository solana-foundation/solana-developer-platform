import { SigningError } from "@sdp/custody/signing";
import { describe, expect, it } from "vitest";
import type { Env } from "@/types/env";
import { createSigningAdapterFromConfig, type SigningConfigRecord } from "./index";

const LOCAL_RECORD: SigningConfigRecord = {
  id: "cfg_local",
  organizationId: "org_1",
  projectId: null,
  provider: "local",
  config: "{}",
  encryptionVersion: "sdp-custody-kms-v2",
  defaultWalletId: null,
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("createSigningAdapterFromConfig", () => {
  it("refuses a stored local config instead of signing with the operator key", async () => {
    const env = { CUSTODY_PRIVATE_KEY: "3".repeat(88) } as Env;

    await expect(createSigningAdapterFromConfig(LOCAL_RECORD, env)).rejects.toBeInstanceOf(
      SigningError
    );
  });

  it("refuses even when no operator key is configured", async () => {
    await expect(createSigningAdapterFromConfig(LOCAL_RECORD, {} as Env)).rejects.toThrow(
      /Local signing cannot be built from a stored configuration record/
    );
  });
});
