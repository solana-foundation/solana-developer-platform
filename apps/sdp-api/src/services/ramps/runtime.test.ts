import { SdpPaymentsError } from "@sdp/payments/errors";
import type { RampProviderCredentials } from "@sdp/payments/ramps/types";
import { RAMP_PROVIDERS, type RampProviderId } from "@sdp/types/provider-access";
import { CLUSTER_BY_SDP_ENVIRONMENT } from "@sdp/types/well-known-tokens";
import { describe, expect, it } from "vitest";
import { type ManagedRampKeysEnv, rampRuntimeFor, resolveManagedRampCredentials } from "./runtime";

interface ManagedRampCase {
  /** The managed keys as mounted, by env var. */
  env: ManagedRampKeysEnv;
  credentials: RampProviderCredentials;
  /** A live key per mounted name, as one mounted by mistake. */
  liveKeys: ManagedRampKeysEnv;
  refusals: { production: string; missing: string; liveKey: string };
}

const CASES = {
  moonpay: {
    env: {
      MOONPAY_SANDBOX_API_KEY: "pk_test_managed",
      MOONPAY_SANDBOX_SECRET_KEY: "sk_test_managed",
    },
    credentials: { publicKey: "pk_test_managed", secretKey: "sk_test_managed" },
    liveKeys: {
      MOONPAY_SANDBOX_API_KEY: "pk_live_mounted_by_mistake",
      MOONPAY_SANDBOX_SECRET_KEY: "sk_live_mounted_by_mistake",
    },
    refusals: {
      production: "MoonPay is not configured for production projects.",
      missing:
        "MoonPay sandbox is not configured. Set MOONPAY_SANDBOX_API_KEY and MOONPAY_SANDBOX_SECRET_KEY.",
      liveKey: "MoonPay sandbox keys must be test-mode keys.",
    },
  },
  stripe: {
    env: {
      STRIPE_SANDBOX_SECRET_KEY: "sk_test_managed",
      STRIPE_SANDBOX_PUBLISHABLE_KEY: "pk_test_managed",
    },
    credentials: { publicKey: "pk_test_managed", secretKey: "sk_test_managed" },
    liveKeys: {
      STRIPE_SANDBOX_SECRET_KEY: "sk_live_mounted_by_mistake",
      STRIPE_SANDBOX_PUBLISHABLE_KEY: "pk_live_mounted_by_mistake",
    },
    refusals: {
      production: "Stripe is not configured for production projects.",
      missing:
        "Stripe sandbox is not configured. Set STRIPE_SANDBOX_SECRET_KEY and STRIPE_SANDBOX_PUBLISHABLE_KEY.",
      liveKey: "Stripe sandbox keys must be test-mode keys.",
    },
  },
} as const satisfies Record<RampProviderId, ManagedRampCase>;

describe.each(RAMP_PROVIDERS)("SDP's managed %s keys", (provider) => {
  const managed: ManagedRampCase = CASES[provider];

  it("serve sandbox, trimmed, on the sandbox cluster", () => {
    const padded = Object.fromEntries(
      Object.entries(managed.env).map(([name, value]) => [name, ` ${value} `])
    );
    expect(resolveManagedRampCredentials(padded, provider, "sandbox")).toEqual({
      ok: true,
      credentials: managed.credentials,
    });
    expect(rampRuntimeFor(managed.env, provider, "sandbox")).toEqual({
      mode: "sandbox",
      cluster: CLUSTER_BY_SDP_ENVIRONMENT.sandbox,
      credentials: managed.credentials,
    });
  });

  it("never serve production, which brings its own account", () => {
    expect(resolveManagedRampCredentials(managed.env, provider, "production")).toEqual({
      ok: false,
      reason: managed.refusals.production,
    });
  });

  it.each(Object.keys(managed.env))("refuse sandbox without %s, naming every key", (name) => {
    expect(
      resolveManagedRampCredentials({ ...managed.env, [name]: " " }, provider, "sandbox")
    ).toEqual({ ok: false, reason: managed.refusals.missing });
  });

  it.each(Object.entries(managed.liveKeys))("refuse a live key mounted as %s", (name, liveKey) => {
    expect(
      resolveManagedRampCredentials({ ...managed.env, [name]: liveKey }, provider, "sandbox")
    ).toEqual({ ok: false, reason: managed.refusals.liveKey });
  });

  it("throw PROVIDER_NOT_CONFIGURED when building a runtime they can't serve", () => {
    expect(() => rampRuntimeFor(managed.env, provider, "production")).toThrow(
      new SdpPaymentsError("PROVIDER_NOT_CONFIGURED", managed.refusals.production)
    );
  });
});
