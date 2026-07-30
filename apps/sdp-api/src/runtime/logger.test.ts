import pino from "pino";
import { describe, expect, it } from "vitest";
import { baseLoggerOptions, getLogContext, runWithLogContext } from "./logger";

function captureLogger() {
  const records: Record<string, unknown>[] = [];
  const logger = pino(baseLoggerOptions(), {
    write: (line: string) => records.push(JSON.parse(line)),
  });
  return { logger, records };
}

describe("logger context", () => {
  it("has no request context outside runWithLogContext", () => {
    expect(getLogContext()).toEqual({});
  });

  it("injects request_id and trace_id as first-class fields inside the context", () => {
    const { logger, records } = captureLogger();

    runWithLogContext({ request_id: "req_1", trace_id: "trace_1" }, () => {
      logger.info({ transfer_id: "tr_1" }, "transfer submitted");
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      request_id: "req_1",
      trace_id: "trace_1",
      transfer_id: "tr_1",
      message: "transfer submitted",
    });
  });

  it("propagates context across awaited nested calls without threading params", async () => {
    const { logger, records } = captureLogger();

    async function nested() {
      await Promise.resolve();
      logger.error({ transfer_id: "tr_2" }, "transfer failed");
    }

    await runWithLogContext({ request_id: "req_2" }, () => nested());

    expect(records[0]).toMatchObject({ request_id: "req_2", transfer_id: "tr_2" });
    expect(records[0]).not.toHaveProperty("trace_id");
  });

  it("keeps transfer_id queryable as a field, not embedded in the message", () => {
    const { logger, records } = captureLogger();

    runWithLogContext({ request_id: "req_3" }, () => {
      logger.info({ transfer_id: "tr_3" }, "settled");
    });

    expect(records[0].transfer_id).toBe("tr_3");
    expect(records[0].message).toBe("settled");
  });

  it("expands Error values under the error field", () => {
    const { logger, records } = captureLogger();

    logger.error({ error: new Error("boom") }, "failed");

    expect(records[0].error).toMatchObject({ type: "Error", message: "boom" });
  });
});
