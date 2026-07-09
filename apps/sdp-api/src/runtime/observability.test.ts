import { describe, expect, it } from "vitest";
import type { Env } from "@/types/env";
import { getSentryOptions, isSentryEnabled } from "./observability";

const envWith = (overrides: Partial<Env>): Env =>
  ({
    ENVIRONMENT: "development",
    SENTRY_DSN: undefined,
    SENTRY_ENVIRONMENT: undefined,
    SENTRY_TRACES_SAMPLE_RATE: undefined,
    ...overrides,
  }) as Env;

describe("isSentryEnabled", () => {
  it("returns false when SENTRY_DSN is missing", () => {
    expect(isSentryEnabled(envWith({ SENTRY_ENVIRONMENT: "staging" }))).toBe(false);
  });

  it("returns false when SENTRY_DSN is whitespace-only", () => {
    expect(isSentryEnabled(envWith({ SENTRY_DSN: "   ", SENTRY_ENVIRONMENT: "staging" }))).toBe(
      false
    );
  });

  it("returns false when SENTRY_ENVIRONMENT is missing (local dev)", () => {
    expect(isSentryEnabled(envWith({ SENTRY_DSN: "https://example.io/1" }))).toBe(false);
  });

  it("returns true when both SENTRY_DSN and SENTRY_ENVIRONMENT are set", () => {
    expect(
      isSentryEnabled(
        envWith({ SENTRY_DSN: "https://example.io/1", SENTRY_ENVIRONMENT: "staging" })
      )
    ).toBe(true);
    expect(
      isSentryEnabled(
        envWith({ SENTRY_DSN: "  https://example.io/1  ", SENTRY_ENVIRONMENT: "production" })
      )
    ).toBe(true);
  });

  it("agrees with getSentryOptions.enabled (single source of truth)", () => {
    const cases: Partial<Env>[] = [
      {},
      { SENTRY_DSN: "" },
      { SENTRY_DSN: "   ", SENTRY_ENVIRONMENT: "staging" },
      { SENTRY_DSN: "https://example.io/1" },
      { SENTRY_DSN: "https://example.io/1", SENTRY_ENVIRONMENT: "staging" },
      { SENTRY_DSN: "  https://example.io/1  ", SENTRY_ENVIRONMENT: "production" },
    ];
    for (const overrides of cases) {
      const env = envWith(overrides);
      expect(isSentryEnabled(env)).toBe(getSentryOptions(env).enabled);
    }
  });
});

describe("getSentryOptions", () => {
  it("disables Sentry when SENTRY_DSN is missing", () => {
    const opts = getSentryOptions(envWith({ SENTRY_ENVIRONMENT: "staging" }));
    expect(opts.enabled).toBe(false);
    expect("dsn" in opts).toBe(false);
  });

  it("disables Sentry when SENTRY_ENVIRONMENT is missing (local dev)", () => {
    const opts = getSentryOptions(envWith({ SENTRY_DSN: "https://example.io/1" }));
    expect(opts.enabled).toBe(false);
    expect("dsn" in opts).toBe(false);
    expect("environment" in opts).toBe(false);
  });

  it("enables Sentry when both are set and trims the DSN", () => {
    const opts = getSentryOptions(
      envWith({ SENTRY_DSN: "  https://example.io/1  ", SENTRY_ENVIRONMENT: "staging" })
    );
    expect(opts.enabled).toBe(true);
    expect(opts.dsn).toBe("https://example.io/1");
  });

  it("propagates SENTRY_ENVIRONMENT into options", () => {
    const enabled = (environment: "staging" | "production") =>
      getSentryOptions(
        envWith({ SENTRY_DSN: "https://example.io/1", SENTRY_ENVIRONMENT: environment })
      );
    expect(enabled("staging").environment).toBe("staging");
    expect(enabled("production").environment).toBe("production");
  });

  it("sets sendDefaultPii to false unconditionally", () => {
    expect(getSentryOptions(envWith({})).sendDefaultPii).toBe(false);
    expect(
      getSentryOptions(envWith({ SENTRY_DSN: "https://x", SENTRY_ENVIRONMENT: "production" }))
        .sendDefaultPii
    ).toBe(false);
  });

  describe("tracesSampleRate", () => {
    it("defaults to 0.1 in production when SENTRY_TRACES_SAMPLE_RATE is unset", () => {
      const opts = getSentryOptions(envWith({ SENTRY_ENVIRONMENT: "production" }));
      expect(opts.tracesSampleRate).toBe(0.1);
    });

    it("defaults to 1 outside production when SENTRY_TRACES_SAMPLE_RATE is unset", () => {
      expect(getSentryOptions(envWith({ SENTRY_ENVIRONMENT: "staging" })).tracesSampleRate).toBe(1);
      expect(getSentryOptions(envWith({})).tracesSampleRate).toBe(1);
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
        envWith({ SENTRY_ENVIRONMENT: "production", SENTRY_TRACES_SAMPLE_RATE: "abc" })
      );
      expect(opts.tracesSampleRate).toBe(0.1);
    });

    it("falls back to the env default on out-of-range SENTRY_TRACES_SAMPLE_RATE", () => {
      const overRange = getSentryOptions(
        envWith({ SENTRY_ENVIRONMENT: "production", SENTRY_TRACES_SAMPLE_RATE: "1.5" })
      );
      expect(overRange.tracesSampleRate).toBe(0.1);

      const negative = getSentryOptions(
        envWith({ SENTRY_ENVIRONMENT: "staging", SENTRY_TRACES_SAMPLE_RATE: "-0.1" })
      );
      expect(negative.tracesSampleRate).toBe(1);
    });
  });
});
