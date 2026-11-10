import { setRpcTelemetrySink } from "@sdp/rpc/telemetry";
import pino from "pino";
import { afterEach, beforeEach, type MockInstance, vi } from "vitest";
import { z } from "zod";
import { baseLoggerOptions, rootLogger } from "@/runtime/logger";
import { installRpcTelemetrySink } from "@/runtime/rpc-telemetry";

const logLineSchema = z.record(z.string(), z.unknown());

/**
 * Install the API's RPC telemetry sink and record the root logger's `info`/`warn`/`error` lines,
 * serialized with its own options (log context, scrubbing, formatters). Register at `describe`
 * level after the hooks whose lines a test should not see.
 *
 * @returns The current test's lines in write order; emptied after each test.
 */
export function installLogLineCapture(): readonly Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  const recorder = pino(baseLoggerOptions(), {
    write: (line: string) => {
      lines.push(logLineSchema.parse(JSON.parse(line)));
    },
  });
  const spies: MockInstance[] = [];

  beforeEach(() => {
    installRpcTelemetrySink();
    spies.push(
      vi.spyOn(rootLogger, "info").mockImplementation(recorder.info.bind(recorder)),
      vi.spyOn(rootLogger, "warn").mockImplementation(recorder.warn.bind(recorder)),
      vi.spyOn(rootLogger, "error").mockImplementation(recorder.error.bind(recorder))
    );
  });

  afterEach(() => {
    setRpcTelemetrySink(null);
    for (const spy of spies) spy.mockRestore();
    spies.length = 0;
    lines.length = 0;
  });

  return lines;
}
