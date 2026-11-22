import type { AllowedEndpoint } from "@sdp/safe-proxy-endpoints/endpoint";
import { SAFE_PROXY_CODES, type SafeProxyCode } from "@sdp/safe-proxy-endpoints/protocol";
import type { SafeProxyProvider } from "@sdp/safe-proxy-endpoints/providers";
import type { SafeProxyForwardResult, SafeProxyProviderCallState } from "@sdp/types/safe-proxy";
import type { IdentifiedCaller } from "./caller";
import { ProviderAnswerTooLarge, Refusal } from "./refusal";

// How far a request got: received -> identified -> matched.
export type Progress =
  | { stage: "received" }
  | { stage: "identified"; caller: IdentifiedCaller }
  | {
      stage: "matched";
      caller: IdentifiedCaller;
      provider: SafeProxyProvider;
      endpoint: AllowedEndpoint;
      providerCall: SafeProxyProviderCallState;
    };

export type RequestOutcome =
  | { result: "forwarded" }
  | {
      result: Exclude<SafeProxyForwardResult, "forwarded">;
      code: SafeProxyCode;
      // The class of the thrown error when the code is `internal`, otherwise null.
      errorName: string | null;
    };

export function providerCallOf(progress: Progress): SafeProxyProviderCallState {
  switch (progress.stage) {
    case "received":
    case "identified":
      return "not_sent";
    case "matched":
      return progress.providerCall;
    default: {
      const unreachable: never = progress;
      return unreachable;
    }
  }
}

// The one place a thrown error becomes a code. Once the request has left, every failure is
// reported as no answer.
export function failureOutcome(
  error: Error,
  progress: Progress
): Exclude<RequestOutcome, { result: "forwarded" }> {
  const providerCall = providerCallOf(progress);
  switch (providerCall) {
    case "not_sent": {
      if (error instanceof Refusal) {
        return { result: SAFE_PROXY_CODES[error.code], code: error.code, errorName: null };
      }
      return {
        result: SAFE_PROXY_CODES.internal,
        code: "internal",
        errorName: error.constructor.name,
      };
    }
    case "in_flight":
    case "answered": {
      const code =
        error instanceof ProviderAnswerTooLarge
          ? "provider_answer_too_large"
          : "provider_no_answer";
      return { result: SAFE_PROXY_CODES[code], code, errorName: null };
    }
    default: {
      const unreachable: never = providerCall;
      return unreachable;
    }
  }
}
