import { scrubTelemetry } from "@sdp/redaction/scrub";
import pino, { type DestinationStream } from "pino";
import { type Progress, providerCallOf, type RequestOutcome } from "./request-result";

function progressFields(progress: Progress) {
  switch (progress.stage) {
    case "received":
      return {
        caller: null,
        caller_token_age_s: null,
        provider: null,
        endpoint_method: null,
        endpoint_path: null,
      };
    case "identified":
      return {
        caller: progress.caller.caller,
        caller_token_age_s: progress.caller.tokenAgeSeconds,
        provider: null,
        endpoint_method: null,
        endpoint_path: null,
      };
    case "matched":
      return {
        caller: progress.caller.caller,
        caller_token_age_s: progress.caller.tokenAgeSeconds,
        provider: progress.provider,
        endpoint_method: progress.endpoint.method,
        // The declared pattern, never the path that was requested.
        endpoint_path: progress.endpoint.path,
      };
    default: {
      const unreachable: never = progress;
      return unreachable;
    }
  }
}

export function requestLogLine(request: {
  requestId: string | null;
  progress: Progress;
  outcome: RequestOutcome;
  durationMs: number;
  revision: string;
}) {
  return {
    request_id: request.requestId,
    ...progressFields(request.progress),
    result: request.outcome.result,
    code: request.outcome.result === "forwarded" ? null : request.outcome.code,
    error_name: request.outcome.result === "forwarded" ? null : request.outcome.errorName,
    provider_call: providerCallOf(request.progress),
    duration_ms: request.durationMs,
    revision: request.revision,
  };
}

export type RequestLogLine = ReturnType<typeof requestLogLine>;

export type WriteRequestLog = (line: RequestLogLine) => void;

export function createRequestLog(destination: DestinationStream): WriteRequestLog {
  const logger = pino(
    {
      base: undefined,
      messageKey: "message",
      formatters: {
        level: (label, number) => ({ level: number, severity: label.toUpperCase() }),
      },
      hooks: {
        logMethod(args, method) {
          // SAFETY: the scrubber returns each argument with its type unchanged.
          method.apply(this, args.map((argument) => scrubTelemetry(argument)) as typeof args);
        },
      },
    },
    destination
  );
  return (line) => (line.code === "internal" ? logger.error(line) : logger.info(line));
}
