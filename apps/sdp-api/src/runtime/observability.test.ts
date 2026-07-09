import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "@/types/env";
import { getSentryOptions, isSentryEnabled } from "./observability";

const envWith = (overrides: Partial<Env>): Env =>
  ({
    ENVIRONMENT: "development",
    SENTRY_DSN: undefined,
    SENTRY_TRACES_SAMPLE_RATE: undefined,
    ...overrides,
  }) as Env;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isSentryEnabled", () => {
  it("returns false when SENTRY_DSN is missing", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(isSentryEnabled(envWith({}))).toBe(false);
  });

  it("returns false when SENTRY_DSN is whitespace-only", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(isSentryEnabled(envWith({ SENTRY_DSN: "   " }))).toBe(false);
  });

  it("returns false under a development NODE_ENV (local dev)", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(isSentryEnabled(envWith({ SENTRY_DSN: "https://example.io/1" }))).toBe(false);
  });

  it("fails closed when NODE_ENV is not production", () => {
    vi.stubEnv("NODE_ENV", "");
    expect(isSentryEnabled(envWith({ SENTRY_DSN: "https://example.io/1" }))).toBe(false);
  });

  it("returns true when SENTRY_DSN is set and NODE_ENV is production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(isSentryEnabled(envWith({ SENTRY_DSN: "https://example.io/1" }))).toBe(true);
    expect(isSentryEnabled(envWith({ SENTRY_DSN: "  https://example.io/1  " }))).toBe(true);
  });

  it("agrees with getSentryOptions.enabled (single source of truth)", () => {
    vi.stubEnv("NODE_ENV", "production");
    const cases: Partial<Env>[] = [
      {},
      { SENTRY_DSN: "" },
      { SENTRY_DSN: "   " },
      { SENTRY_DSN: "https://example.io/1" },
      { SENTRY_DSN: "  https://example.io/1  " },
    ];
    for (const overrides of cases) {
      const env = envWith(overrides);
      expect(isSentryEnabled(env)).toBe(getSentryOptions(env).enabled);
    }
  });
});

describe("getSentryOptions", () => {
  it("disables Sentry when SENTRY_DSN is missing", () => {
    vi.stubEnv("NODE_ENV", "production");
    const opts = getSentryOptions(envWith({}));
    expect(opts.enabled).toBe(false);
    expect("dsn" in opts).toBe(false);
  });

  it("disables Sentry under a development NODE_ENV even with a DSN", () => {
    vi.stubEnv("NODE_ENV", "development");
    const opts = getSentryOptions(envWith({ SENTRY_DSN: "https://example.io/1" }));
    expect(opts.enabled).toBe(false);
  });

  it("enables Sentry when SENTRY_DSN is set and trims it", () => {
    vi.stubEnv("NODE_ENV", "production");
    const opts = getSentryOptions(envWith({ SENTRY_DSN: "  https://example.io/1  " }));
    expect(opts.enabled).toBe(true);
    expect(opts.dsn).toBe("https://example.io/1");
  });

  it("propagates ENVIRONMENT into options", () => {
    expect(getSentryOptions(envWith({ ENVIRONMENT: "production" })).environment).toBe("production");
    expect(getSentryOptions(envWith({ ENVIRONMENT: "development" })).environment).toBe(
      "development"
    );
  });

  it("sets sendDefaultPii to false unconditionally", () => {
    expect(getSentryOptions(envWith({})).sendDefaultPii).toBe(false);
    expect(getSentryOptions(envWith({ SENTRY_DSN: "https://x" })).sendDefaultPii).toBe(false);
  });

  describe("tracesSampleRate", () => {
    it("defaults to 0.1 in production when SENTRY_TRACES_SAMPLE_RATE is unset", () => {
      const opts = getSentryOptions(envWith({ ENVIRONMENT: "production" }));
      expect(opts.tracesSampleRate).toBe(0.1);
    });

    it("defaults to 1 outside production when SENTRY_TRACES_SAMPLE_RATE is unset", () => {
      expect(getSentryOptions(envWith({ ENVIRONMENT: "development" })).tracesSampleRate).toBe(1);
    });

    it("uses a valid SENTRY_TRACES_SAMPLE_RATE between 0 and 1", () => {
      expect(getSentryOptions(envWith({ SENTRY_TRACES_SAMPLE_RATE: "0.5" })).tracesSampleRate).toBe(
        0.5
      );
      expect(getSentryOptions(envWith({ SENTRY_TRACES_SAMPLE_RATE: "0" })).tracesSampleRate).toBe(
        0
      );
      expect(getSentryOptions(envWith({ SENTRY_TRACES_SAMPLE_RATE: "1" })).tracesSampleRate).toBe(
        1
      );
    });

    it("falls back to the env default on non-numeric SENTRY_TRACES_SAMPLE_RATE", () => {
      const opts = getSentryOptions(
        envWith({ ENVIRONMENT: "production", SENTRY_TRACES_SAMPLE_RATE: "abc" })
      );
      expect(opts.tracesSampleRate).toBe(0.1);
    });

    it("falls back to the env default on out-of-range SENTRY_TRACES_SAMPLE_RATE", () => {
      const overRange = getSentryOptions(
        envWith({ ENVIRONMENT: "production", SENTRY_TRACES_SAMPLE_RATE: "1.5" })
      );
      expect(overRange.tracesSampleRate).toBe(0.1);

      const negative = getSentryOptions(
        envWith({ ENVIRONMENT: "development", SENTRY_TRACES_SAMPLE_RATE: "-0.1" })
      );
      expect(negative.tracesSampleRate).toBe(1);
    });
  });
});
