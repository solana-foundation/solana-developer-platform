import { describe, expect, it, vi } from "vitest";
import type { BackgroundRunner } from "@/runtime/background";
import type { Observability } from "@/runtime/observability";
import { cleanupRetiredProviderCredentialSecrets } from "@/services/jobs/cleanup-provider-credential-secrets";
import type { Env } from "@/types/env";
import {
  PROVIDER_CREDENTIAL_SECRET_CLEANUP_CRON,
  PROVIDER_CREDENTIAL_SECRET_CLEANUP_MONITOR,
  runProviderCredentialSecretCleanup,
} from "./provider-credential-secret-cleanup";

vi.mock("@/services/jobs/cleanup-provider-credential-secrets", () => ({
  cleanupRetiredProviderCredentialSecrets: vi.fn(async () => ({
    cleaned: 0,
    skipped: 0,
    failed: 0,
  })),
}));

describe("runProviderCredentialSecretCleanup", () => {
  it("runs the cleanup through its five-minute monitor and background tracker", async () => {
    const env = {} as Env;
    const bg = { run: vi.fn(), awaitAll: vi.fn(), draining: false } satisfies BackgroundRunner;
    const observability = {
      captureException: vi.fn(),
      withScope: vi.fn(),
      withMonitor: vi.fn((_slug, work) => work()),
    } satisfies Observability;

    runProviderCredentialSecretCleanup({ env, bg, observability });

    expect(observability.withMonitor).toHaveBeenCalledExactlyOnceWith(
      PROVIDER_CREDENTIAL_SECRET_CLEANUP_MONITOR,
      expect.any(Function),
      { schedule: { type: "crontab", value: PROVIDER_CREDENTIAL_SECRET_CLEANUP_CRON } }
    );
    expect(cleanupRetiredProviderCredentialSecrets).toHaveBeenCalledExactlyOnceWith(env);
    expect(bg.run).toHaveBeenCalledOnce();
    await vi.mocked(bg.run).mock.calls[0][0];
  });
});
