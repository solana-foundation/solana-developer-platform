import { afterEach, beforeEach } from "vitest";
import { env } from "@/test/helpers/env";

/** Sandbox keys in Hercle's formats; the webhook key is only a placeholder of a PEM's shape. */
export const HERCLE_TEST_ENV = {
  HERCLE_SANDBOX_CLIENT_ID: "hpk_test_RouteTestsClientId0001",
  HERCLE_SANDBOX_SECRET_KEY: "RouteTestsSecretKey000000000000000000000000",
  HERCLE_SANDBOX_WEBHOOK_PUBLIC_KEY:
    "-----BEGIN PUBLIC KEY-----\nroute-tests\n-----END PUBLIC KEY-----\n",
} as const;

type HercleTestEnv = { [Key in keyof typeof HERCLE_TEST_ENV]: string };

/**
 * Configures Hercle on the shared test env before each test in the calling suite.
 * It restores the previous values after each test.
 *
 * @param overrides - Keys to set instead of the defaults, such as a real webhook public key.
 */
export function installHercleTestEnv(overrides: Partial<HercleTestEnv> = {}): void {
  let saved: Pick<typeof env, keyof typeof HERCLE_TEST_ENV>;

  beforeEach(() => {
    saved = {
      HERCLE_SANDBOX_CLIENT_ID: env.HERCLE_SANDBOX_CLIENT_ID,
      HERCLE_SANDBOX_SECRET_KEY: env.HERCLE_SANDBOX_SECRET_KEY,
      HERCLE_SANDBOX_WEBHOOK_PUBLIC_KEY: env.HERCLE_SANDBOX_WEBHOOK_PUBLIC_KEY,
    };
    Object.assign(env, HERCLE_TEST_ENV, overrides);
  });

  afterEach(() => {
    Object.assign(env, saved);
  });
}
