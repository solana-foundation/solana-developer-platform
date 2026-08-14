import { describe, expect, it, vi } from "vitest";
import { describeError, logEvent } from "./money-path-events";

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

vi.mock("./logger", () => ({ getLogger: () => logger }));

describe("logEvent", () => {
  it("swallows a logger failure so telemetry cannot change a money-path outcome", () => {
    logger.warn.mockImplementationOnce(() => {
      throw new Error("transport closed");
    });

    expect(() => logEvent("warn", { event: "sdp_api_sponsorship_denied" })).not.toThrow();
  });

  it("names the event as the log message", () => {
    logEvent("info", { event: "sdp_api_sponsorship_reconciliation_tick", candidates: 3 });

    expect(logger.info).toHaveBeenCalledWith(
      { event: "sdp_api_sponsorship_reconciliation_tick", candidates: 3 },
      "sdp_api_sponsorship_reconciliation_tick"
    );
  });
});

describe("describeError", () => {
  it("keeps the error identity without its message", () => {
    const failure = new Error("postgres://user:hunter2@host/db is unreachable");
    expect(describeError(failure)).toEqual({ error_name: "Error", error_code: undefined });
  });

  it("keeps a driver error code, which carries no secret", () => {
    const failure = Object.assign(new Error("duplicate key"), { code: "23505" });
    expect(describeError(failure)).toEqual({ error_name: "Error", error_code: "23505" });
  });

  it("describes a thrown non-error without stringifying it", () => {
    expect(describeError("postgres password=secret")).toEqual({ error_name: "string" });
  });
});
