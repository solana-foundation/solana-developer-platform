import pino from "pino";
import { describe, expect, it } from "vitest";
import {
  LOG_REDACTION_PATHS,
  REDACTED_LEAF_FIELDS,
  REDACTED_NESTED_PATHS,
  REDACTION_CENSOR,
} from "./log-redaction";
import { baseLoggerOptions } from "./logger";

/**
 * Stands in for `SecretRef` from `@sdp/helius-rings`, which sdp-api does not yet
 * depend on — A5 adds that dependency when the repositories need the domain
 * types. What matters here is the contract pino relies on, `toJSON()` returning
 * the censor; that `SecretRef` honours it is asserted in
 * packages/sdp-helius-rings/src/secrets.test.ts.
 */
class WrappedSecret {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  reveal(): string {
    return this.#value;
  }
  toJSON(): string {
    return REDACTION_CENSOR;
  }
}

/** Captures what the real logger options would actually emit to a sink. */
function captureLogs(write: (logger: pino.Logger) => void): string {
  const lines: string[] = [];
  const logger = pino(
    { ...baseLoggerOptions(), transport: undefined, timestamp: false },
    { write: (line: string) => lines.push(line) }
  );
  write(logger);
  return lines.join("\n");
}

describe("log redaction registry", () => {
  it("expands every registered field to the root and one level deep", () => {
    for (const field of [...REDACTED_LEAF_FIELDS, ...REDACTED_NESTED_PATHS]) {
      expect(LOG_REDACTION_PATHS).toContain(field);
      expect(LOG_REDACTION_PATHS).toContain(`*.${field}`);
    }
  });

  it("is accepted by pino — an unsupported path shape throws at construction", () => {
    expect(() => captureLogs((logger) => logger.info("ok"))).not.toThrow();
  });

  it("censors the Rings key domain at the root of a log object", () => {
    const output = captureLogs((logger) => {
      logger.info({ viewingKey: "vk-plaintext", nullifierKey: "nk-plaintext" }, "provisioned");
    });

    expect(output).not.toContain("vk-plaintext");
    expect(output).not.toContain("nk-plaintext");
    expect(output).toContain(REDACTION_CENSOR);
  });

  it("censors the Rings key domain one level deep, where callers actually put it", () => {
    const output = captureLogs((logger) => {
      logger.info({ wallet: { id: "hrw_1", viewingKey: "vk-plaintext" } }, "wallet ready");
    });

    expect(output).not.toContain("vk-plaintext");
    expect(output).toContain("hrw_1");
  });

  it("censors proof internals and key ref material", () => {
    const output = captureLogs((logger) => {
      logger.info(
        {
          operation: {
            id: "hro_1",
            proof: { ref: "proof-handle", internal: "witness-bytes" },
          },
          keyRefs: [{ material: "blob-a" }, { material: "blob-b" }],
        },
        "proof received"
      );
    });

    expect(output).not.toContain("proof-handle");
    expect(output).not.toContain("witness-bytes");
    expect(output).not.toContain("blob-a");
    expect(output).not.toContain("blob-b");
    expect(output).toContain("hro_1");
  });

  it("censors the gateway metadata envelope", () => {
    const output = captureLogs((logger) => {
      logger.info({ ringsMetadata: { anything: "opaque-upstream-detail" } }, "gateway replied");
    });

    expect(output).not.toContain("opaque-upstream-detail");
  });

  it("leaves a wrapped secret redacted by the wrapper, at any depth", () => {
    // This is why the one-level limit on the registry is tolerable: a wrapped
    // secret redacts itself through toJSON(), so depth does not matter for
    // wrapped material. The registry only has to cover plaintext that escaped
    // wrapping.
    const output = captureLogs((logger) => {
      logger.info(
        { a: { b: { c: { secret: new WrappedSecret("hunter2"), note: "deeply nested" } } } },
        "deep"
      );
    });

    expect(output).not.toContain("hunter2");
    expect(output).toContain(REDACTION_CENSOR);
    expect(output).toContain("deeply nested");
  });

  it("keeps ordinary operational fields readable", () => {
    const output = captureLogs((logger) => {
      logger.info(
        { operation: { id: "hro_2", state: "proving", opType: "transfer_anonymous" } },
        "advanced"
      );
    });

    expect(output).toContain("hro_2");
    expect(output).toContain("proving");
    expect(output).toContain("transfer_anonymous");
    expect(output).not.toContain(REDACTION_CENSOR);
  });
});
