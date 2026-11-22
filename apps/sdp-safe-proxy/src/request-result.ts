import type { AllowedEndpoint } from "@sdp/safe-proxy-endpoints/endpoint";
import {
  type ForwardResult,
  SAFE_PROXY_CODES,
  type SafeProxyCode,
} from "@sdp/safe-proxy-endpoints/protocol";
import type { SafeProxyProvider } from "@sdp/safe-proxy-endpoints/providers";
import type { IdentifiedCaller } from "./caller";
import { Refusal } from "./refusal";

// not_sent -> in_flight -> answered. A request makes one provider call and never goes back.
export const PROVIDER_CALL_STATES = ["not_sent", "in_flight", "answered"] as const;
export type ProviderCallState = (typeof PROVIDER_CALL_STATES)[number];

// How far a request got: received -> identified -> matched.
export type Progress =
  | { stage: "received" }
  | { stage: "identified"; caller: IdentifiedCaller }
  | {
      stage: "matched";
      caller: IdentifiedCaller;
      provider: SafeProxyProvider;
      endpoint: AllowedEndpoint;
      providerCall: ProviderCallState;
    };

export type RequestOutcome =
  | { result: "forwarded" }
  | { result: Exclude<ForwardResult, "forwarded">; code: SafeProxyCode };

export function providerCallOf(progress: Progress): ProviderCallState {
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
      const code = error instanceof Refusal ? error.code : "internal";
      return { result: SAFE_PROXY_CODES[code], code };
    }
    case "in_flight":
    case "answered":
      return { result: SAFE_PROXY_CODES.provider_no_answer, code: "provider_no_answer" };
    default: {
      const unreachable: never = providerCall;
      return unreachable;
    }
  }
}
