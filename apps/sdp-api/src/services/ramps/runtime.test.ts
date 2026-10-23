import { SdpPaymentsError } from "@sdp/payments/errors";
import { SDP_ENVIRONMENTS, type SdpEnvironment } from "@sdp/types/api-keys";
import { RAMP_PROVIDERS, type RampProviderId } from "@sdp/types/provider-access";
import { CLUSTER_BY_SDP_ENVIRONMENT } from "@sdp/types/well-known-tokens";
import { describe, expect, it } from "vitest";
import {
  isManagedRampConfigured,
  MANAGED_RAMP_KEY_NAMES,
  type ManagedRampKeyName,
  type ManagedRampKeysEnv,
  managedRampWebhookSecret,
  rampRuntimeFor,
  resolveManagedRampCredentials,
  resolveManagedRampWebhookSecret,
} from "./runtime";

/** One key as mounted: its env var and a value that fits its mode. */
type MountedKey = readonly [name: ManagedRampKeyName, value: string];

interface ManagedRampModeCase {
  publicKey: MountedKey;
  secretKey: MountedKey;
  webhookSecret: MountedKey;
  /** The other mode's keys, as mounted under this mode's names by mistake. */
  otherModeKeys: { publicKey: string; secretKey: string };
}

const LABELS = { moonpay: "MoonPay", stripe: "Stripe" } as const satisfies Record<
  RampProviderId,
  string
>;

const KEY_MODE_NAMES = {
  sandbox: "test-mode",
  production: "live-mode",
} as const satisfies Record<SdpEnvironment, string>;

/** The convention pinned by hand: `<PROVIDER>_<MODE>_<ROLE>`, public key in the provider's term. */
const CASES = {
  moonpay: {
    sandbox: {
      publicKey: ["MOONPAY_SANDBOX_API_KEY", "pk_test_managed"],
      secretKey: ["MOONPAY_SANDBOX_SECRET_KEY", "sk_test_managed"],
      webhookSecret: ["MOONPAY_SANDBOX_WEBHOOK_SECRET", "wk_test_managed"],
      otherModeKeys: { publicKey: "pk_live_by_mistake", secretKey: "sk_live_by_mistake" },
    },
    production: {
      publicKey: ["MOONPAY_PRODUCTION_API_KEY", "pk_live_managed"],
      secretKey: ["MOONPAY_PRODUCTION_SECRET_KEY", "sk_live_managed"],
      webhookSecret: ["MOONPAY_PRODUCTION_WEBHOOK_SECRET", "wk_live_managed"],
      otherModeKeys: { publicKey: "pk_test_by_mistake", secretKey: "sk_test_by_mistake" },
    },
  },
  stripe: {
    sandbox: {
      publicKey: ["STRIPE_SANDBOX_PUBLISHABLE_KEY", "pk_test_managed"],
      secretKey: ["STRIPE_SANDBOX_SECRET_KEY", "rk_test_managed"],
      webhookSecret: ["STRIPE_SANDBOX_WEBHOOK_SECRET", "whsec_sandbox_managed"],
      otherModeKeys: { publicKey: "pk_live_by_mistake", secretKey: "sk_live_by_mistake" },
    },
    production: {
      publicKey: ["STRIPE_PRODUCTION_PUBLISHABLE_KEY", "pk_live_managed"],
      secretKey: ["STRIPE_PRODUCTION_SECRET_KEY", "sk_live_managed"],
      webhookSecret: ["STRIPE_PRODUCTION_WEBHOOK_SECRET", "whsec_production_managed"],
      otherModeKeys: { publicKey: "pk_test_by_mistake", secretKey: "rk_test_by_mistake" },
    },
  },
} as const satisfies Record<RampProviderId, Record<SdpEnvironment, ManagedRampModeCase>>;

function mounted(...keys: readonly MountedKey[]): ManagedRampKeysEnv {
  return Object.fromEntries(keys);
}

function otherMode(mode: SdpEnvironment): SdpEnvironment {
  return mode === "sandbox" ? "production" : "sandbox";
}

describe("managed ramp key names", () => {
  it("are every provider's keys in both modes, and nothing else", () => {
    const pinned = RAMP_PROVIDERS.flatMap((provider) =>
      SDP_ENVIRONMENTS.flatMap((mode) => {
        const keys: ManagedRampModeCase = CASES[provider][mode];
        return [keys.publicKey[0], keys.secretKey[0], keys.webhookSecret[0]];
      })
    );
    expect([...MANAGED_RAMP_KEY_NAMES].sort()).toEqual(pinned.sort());
  });
});

describe.each(RAMP_PROVIDERS)("SDP's managed %s keys", (provider) => {
  const label = LABELS[provider];

  describe.each(SDP_ENVIRONMENTS)("in %s", (mode) => {
    const keys: ManagedRampModeCase = CASES[provider][mode];
    const env = mounted(keys.publicKey, keys.secretKey, keys.webhookSecret);
    const credentials = { publicKey: keys.publicKey[1], secretKey: keys.secretKey[1] };
    const missingKeys = `${label} ${mode} is not configured. Set ${keys.publicKey[0]} and ${keys.secretKey[0]}.`;
    const wrongModeKeys = `${label} ${mode} keys must be ${KEY_MODE_NAMES[mode]} keys.`;

    it("serve the mode, trimmed, on its cluster", () => {
      const padded = mounted(
        [keys.publicKey[0], ` ${keys.publicKey[1]} `],
        [keys.secretKey[0], `${keys.secretKey[1]}\n`]
      );
      expect(resolveManagedRampCredentials(padded, provider, mode)).toEqual({
        ok: true,
        credentials,
      });
      expect(rampRuntimeFor(env, provider, mode)).toEqual({
        mode,
        cluster: CLUSTER_BY_SDP_ENVIRONMENT[mode],
        credentials,
      });
    });

    it("never serve the other mode", () => {
      const other = otherMode(mode);
      const otherKeys: ManagedRampModeCase = CASES[provider][other];
      expect(resolveManagedRampCredentials(env, provider, other)).toEqual({
        ok: false,
        reason: `${label} ${other} is not configured. Set ${otherKeys.publicKey[0]} and ${otherKeys.secretKey[0]}.`,
      });
      expect(isManagedRampConfigured(env, provider, other)).toBe(false);
    });

    it.each([keys.publicKey[0], keys.secretKey[0]])(
      "refuse without %s, naming both keys",
      (name) => {
        expect(resolveManagedRampCredentials({ ...env, [name]: " " }, provider, mode)).toEqual({
          ok: false,
          reason: missingKeys,
        });
      }
    );

    it.each([
      [keys.publicKey[0], keys.otherModeKeys.publicKey],
      [keys.secretKey[0], keys.otherModeKeys.secretKey],
    ])("refuse the other mode's key mounted as %s", (name, otherModeKey) => {
      expect(
        resolveManagedRampCredentials({ ...env, [name]: otherModeKey }, provider, mode)
      ).toEqual({ ok: false, reason: wrongModeKeys });
    });

    it("treat an unsynced `placeholder` mount as unconfigured", () => {
      const placeholders = mounted(
        [keys.publicKey[0], "placeholder"],
        [keys.secretKey[0], "placeholder"],
        [keys.webhookSecret[0], "placeholder"]
      );
      expect(resolveManagedRampCredentials(placeholders, provider, mode)).toEqual({
        ok: false,
        reason: wrongModeKeys,
      });
      expect(resolveManagedRampWebhookSecret(placeholders, provider, mode)).toEqual({
        ok: false,
        reason: `${label} ${mode} webhook secret has the wrong format.`,
      });
      expect(isManagedRampConfigured(placeholders, provider, mode)).toBe(false);
    });

    it("verify the mode's webhooks with its webhook secret", () => {
      expect(
        managedRampWebhookSecret(
          { ...env, [keys.webhookSecret[0]]: ` ${keys.webhookSecret[1]} ` },
          provider,
          mode
        )
      ).toBe(keys.webhookSecret[1]);
    });

    it("report the provider configured only with every key the mode declares", () => {
      expect(isManagedRampConfigured(env, provider, mode)).toBe(true);
      const withoutWebhookSecret = mounted(keys.publicKey, keys.secretKey);
      expect(isManagedRampConfigured(withoutWebhookSecret, provider, mode)).toBe(false);
      expect(resolveManagedRampWebhookSecret(withoutWebhookSecret, provider, mode)).toEqual({
        ok: false,
        reason: `${label} ${mode} is not configured. Set ${keys.webhookSecret[0]}.`,
      });
    });

    it("throw PROVIDER_NOT_CONFIGURED for a runtime or webhook secret they can't serve", () => {
      expect(() => rampRuntimeFor({}, provider, mode)).toThrow(
        new SdpPaymentsError("PROVIDER_NOT_CONFIGURED", missingKeys)
      );
      expect(() => managedRampWebhookSecret({}, provider, mode)).toThrow(
        new SdpPaymentsError(
          "PROVIDER_NOT_CONFIGURED",
          `${label} ${mode} is not configured. Set ${keys.webhookSecret[0]}.`
        )
      );
    });
  });
});

describe("MoonPay's managed webhook secrets", () => {
  it("refuse the other mode's webhook key, whose format names its mode", () => {
    expect(
      resolveManagedRampWebhookSecret(
        { MOONPAY_SANDBOX_WEBHOOK_SECRET: "wk_live_by_mistake" },
        "moonpay",
        "sandbox"
      )
    ).toEqual({ ok: false, reason: "MoonPay sandbox webhook secret has the wrong format." });
    expect(
      resolveManagedRampWebhookSecret(
        { MOONPAY_PRODUCTION_WEBHOOK_SECRET: "wk_test_by_mistake" },
        "moonpay",
        "production"
      )
    ).toEqual({ ok: false, reason: "MoonPay production webhook secret has the wrong format." });
  });
});
