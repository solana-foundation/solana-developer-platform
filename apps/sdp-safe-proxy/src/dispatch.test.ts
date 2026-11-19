import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { SafeProxyCaller } from "@sdp/safe-proxy-catalog/catalog";
import {
  SAFE_PROXY_ERROR_HTTP_STATUS,
  SafeProxyError,
  type SafeProxyFailure,
} from "@sdp/safe-proxy-catalog/errors";
import type { SafeProxyHandlers } from "@sdp/safe-proxy-catalog/handlers";
import type { ResolveCaller } from "@/caller";
import { type DispatchRequest, dispatch, type RequestLogLine } from "@/dispatch";
import { handlers as realHandlers } from "@/handlers";

type PingHandler = SafeProxyHandlers["system"]["ping"];

// Typed as a Record over the line's keys, so this list tracks RequestLogLine exactly.
const LOG_LINE_KEYS: Record<keyof RequestLogLine, true> = {
  requestId: true,
  caller: true,
  provider: true,
  operation: true,
  organizationId: true,
  projectId: true,
  outcome: true,
  code: true,
  errorType: true,
  durationMs: true,
};

function callerIs(caller: SafeProxyCaller): ResolveCaller {
  return async () => caller;
}

const refuseEveryCaller: ResolveCaller = async () => {
  throw new SafeProxyError({ code: "caller_not_allowed", outcome: "rejected" });
};

function run(resolveCaller: ResolveCaller, handlers: SafeProxyHandlers, request: DispatchRequest) {
  const lines: RequestLogLine[] = [];
  const answered = dispatch({ resolveCaller, handlers, log: (line) => lines.push(line) }, request);
  return { lines, answered };
}

function call(section: string, name: string, body: unknown): DispatchRequest {
  return {
    section,
    name,
    credentials: { authorization: undefined, localCaller: undefined },
    body,
  };
}

function pingCall(body: unknown): DispatchRequest {
  return call("system", "ping", body);
}

const validBody = { requestId: "req_1", budgetMs: 1_000, input: {} };

function countingPing() {
  const calls = { count: 0 };
  const ping: PingHandler = async () => {
    calls.count += 1;
    return { service: "safe-proxy" };
  };
  return { calls, handlers: { system: { ping } } };
}

function onlyLine(lines: RequestLogLine[]): RequestLogLine {
  assert.equal(lines.length, 1);
  const [line] = lines;
  assert.ok(line);
  assert.deepEqual(Object.keys(line).sort(), Object.keys(LOG_LINE_KEYS).sort());
  return line;
}

function failureBody(failure: SafeProxyFailure) {
  return { ok: false, error: failure };
}

describe("dispatch", () => {
  it("answers a valid ping and logs one line naming the request", async () => {
    const { lines, answered } = run(callerIs("api"), realHandlers, pingCall(validBody));
    const answer = await answered;

    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body, { ok: true, output: { service: "safe-proxy" } });
    const line = onlyLine(lines);
    assert.equal(line.requestId, "req_1");
    assert.equal(line.caller, "api");
    assert.equal(line.provider, "system");
    assert.equal(line.operation, "ping");
    assert.equal(line.outcome, "ok");
    assert.equal(line.code, null);
    assert.equal(line.errorType, null);
  });

  it("answers 403 caller_not_allowed for a refused caller without calling the handler", async () => {
    const { calls, handlers } = countingPing();
    const { lines, answered } = run(refuseEveryCaller, handlers, pingCall(validBody));
    const answer = await answered;

    assert.equal(answer.status, 403);
    assert.deepEqual(answer.body, failureBody({ code: "caller_not_allowed", outcome: "rejected" }));
    assert.equal(calls.count, 0);
    const line = onlyLine(lines);
    assert.equal(line.caller, null);
    assert.equal(line.code, "caller_not_allowed");
    assert.equal(line.outcome, "rejected");
  });

  it("checks the caller before looking up the operation", async () => {
    const { lines, answered } = run(
      refuseEveryCaller,
      realHandlers,
      call("system", "nope", validBody)
    );
    const answer = await answered;

    assert.equal(answer.status, 403);
    assert.deepEqual(answer.body, failureBody({ code: "caller_not_allowed", outcome: "rejected" }));
    assert.equal(onlyLine(lines).code, "caller_not_allowed");
  });

  it("answers 404 unknown_operation for names outside the catalog and logs them as unknown", async () => {
    const paths = [
      ["system", "nope"],
      ["nope", "ping"],
      ["system", "constructor"],
      ["system", "toString"],
      ["constructor", "name"],
      ["__proto__", "toString"],
    ] as const;
    for (const [section, name] of paths) {
      const { lines, answered } = run(
        callerIs("api"),
        realHandlers,
        call(section, name, validBody)
      );
      const answer = await answered;

      assert.equal(answer.status, 404, `${section}/${name}`);
      assert.deepEqual(
        answer.body,
        failureBody({ code: "unknown_operation", outcome: "rejected" })
      );
      const line = onlyLine(lines);
      assert.equal(line.provider, "unknown");
      assert.equal(line.operation, "unknown");
      assert.equal(line.code, "unknown_operation");
    }
  });

  it("answers 400 invalid_request for a malformed envelope without calling the handler", async () => {
    const bodies = [
      undefined,
      { budgetMs: 1_000, input: {} },
      { ...validBody, undeclared: "x" },
      { ...validBody, budgetMs: 0 },
      { ...validBody, budgetMs: 60_001 },
    ];
    for (const body of bodies) {
      const { calls, handlers } = countingPing();
      const { lines, answered } = run(callerIs("cron"), handlers, pingCall(body));
      const answer = await answered;

      assert.equal(answer.status, 400, JSON.stringify(body));
      assert.deepEqual(answer.body, failureBody({ code: "invalid_request", outcome: "rejected" }));
      assert.equal(calls.count, 0);
      const line = onlyLine(lines);
      assert.equal(line.code, "invalid_request");
      assert.equal(line.outcome, "rejected");
    }
  });

  it("answers a SafeProxyError from the handler with its code, outcome and status", async () => {
    const failures: SafeProxyFailure[] = [
      { code: "provider_refused", outcome: "rejected" },
      { code: "provider_unavailable", outcome: "no_answer" },
      { code: "credential_not_found", outcome: "rejected" },
    ];
    for (const failure of failures) {
      const ping: PingHandler = async () => {
        throw new SafeProxyError(failure);
      };
      const { lines, answered } = run(callerIs("api"), { system: { ping } }, pingCall(validBody));
      const answer = await answered;

      assert.equal(answer.status, SAFE_PROXY_ERROR_HTTP_STATUS[failure.code]);
      assert.deepEqual(answer.body, failureBody(failure));
      const line = onlyLine(lines);
      assert.equal(line.code, failure.code);
      assert.equal(line.outcome, failure.outcome);
      assert.equal(line.errorType, null);
    }
  });

  it("answers any other handler error as 500 internal without its message", async () => {
    const message = "provider said secret-detail-1234";
    const ping: PingHandler = async () => {
      throw new TypeError(message);
    };
    const { lines, answered } = run(callerIs("api"), { system: { ping } }, pingCall(validBody));
    const answer = await answered;

    assert.equal(answer.status, 500);
    assert.deepEqual(answer.body, failureBody({ code: "internal", outcome: "no_answer" }));
    const line = onlyLine(lines);
    assert.equal(line.code, "internal");
    assert.equal(line.outcome, "no_answer");
    assert.equal(line.errorType, "TypeError");
    for (const written of [JSON.stringify(answer), JSON.stringify(line)]) {
      assert.ok(!written.includes("secret-detail-1234"), written);
    }
  });

  it("answers 504 deadline_exceeded when the handler outlives the budget, aborting its signal", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const seen: { signal: AbortSignal | null } = { signal: null };
      const ping: PingHandler = ({ signal }) => {
        seen.signal = signal;
        return new Promise((_, reject) => {
          signal.addEventListener("abort", () => {
            setTimeout(() => reject(new Error("late failure")), 5);
          });
        });
      };
      const { lines, answered } = run(
        callerIs("api"),
        { system: { ping } },
        pingCall({ ...validBody, budgetMs: 20 })
      );
      const answer = await answered;

      assert.equal(answer.status, 504);
      assert.deepEqual(
        answer.body,
        failureBody({ code: "deadline_exceeded", outcome: "no_answer" })
      );
      assert.equal(seen.signal?.aborted, true);
      const line = onlyLine(lines);
      assert.equal(line.code, "deadline_exceeded");
      // The envelope's 20 ms budget applies, not the operation's 2 s.
      assert.ok(line.durationMs < 1_000, `${line.durationMs}`);

      // The handler rejects 5 ms after the answer; give that rejection time to surface.
      await sleep(50);
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("uses the operation's budget when the envelope's is larger", { timeout: 10_000 }, async () => {
    const ping: PingHandler = ({ signal }) =>
      new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const { lines, answered } = run(
      callerIs("api"),
      { system: { ping } },
      pingCall({ ...validBody, budgetMs: 60_000 })
    );
    const answer = await answered;

    assert.equal(answer.status, 504);
    const line = onlyLine(lines);
    assert.equal(line.code, "deadline_exceeded");
    assert.ok(line.durationMs >= 1_900 && line.durationMs < 9_000, `${line.durationMs}`);
  });

  it("answers only the declared output fields", async () => {
    const ping: PingHandler = async () => {
      const output = { service: "safe-proxy" as const, undeclared: "x" };
      return output;
    };
    const { lines, answered } = run(callerIs("api"), { system: { ping } }, pingCall(validBody));
    const answer = await answered;

    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body, { ok: true, output: { service: "safe-proxy" } });
    assert.equal(onlyLine(lines).outcome, "ok");
  });

  it("answers internal / no_answer when the output fails the response schema", async () => {
    const ping: PingHandler = async () => {
      const output = { service: "safe-proxy" as const };
      // The output type cannot name a wrong value, so the value is replaced at run time.
      Object.defineProperty(output, "service", { value: "other" });
      return output;
    };
    const { lines, answered } = run(callerIs("api"), { system: { ping } }, pingCall(validBody));
    const answer = await answered;

    assert.equal(answer.status, 500);
    assert.deepEqual(answer.body, failureBody({ code: "internal", outcome: "no_answer" }));
    const line = onlyLine(lines);
    assert.equal(line.code, "internal");
    assert.equal(line.errorType, null);
  });
});
