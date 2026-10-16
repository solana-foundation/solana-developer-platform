import { afterEach, beforeEach } from "vitest";
import { env } from "@/test/helpers/env";

const STRIPE_TEST_ENV = {
  STRIPE_SANDBOX_SECRET_KEY: "sk_test_route_tests",
  STRIPE_SANDBOX_PUBLISHABLE_KEY: "pk_test_route_tests",
  STRIPE_SANDBOX_WEBHOOK_SECRET: "whsec_route_tests",
} as const;

/**
 * Configures Stripe on the shared test env before each test in the calling
 * suite, and restores the previous values after it.
 */
export function installStripeTestEnv(): void {
  let saved: Pick<typeof env, keyof typeof STRIPE_TEST_ENV>;

  beforeEach(() => {
    saved = {
      STRIPE_SANDBOX_SECRET_KEY: env.STRIPE_SANDBOX_SECRET_KEY,
      STRIPE_SANDBOX_PUBLISHABLE_KEY: env.STRIPE_SANDBOX_PUBLISHABLE_KEY,
      STRIPE_SANDBOX_WEBHOOK_SECRET: env.STRIPE_SANDBOX_WEBHOOK_SECRET,
    };
    Object.assign(env, STRIPE_TEST_ENV);
  });

  afterEach(() => {
    Object.assign(env, saved);
  });
}
