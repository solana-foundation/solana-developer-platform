import type { SafeProxyCode } from "@sdp/safe-proxy-endpoints/protocol";

// Thrown only while nothing has been sent to the provider.
export class Refusal extends Error {
  constructor(public readonly code: SafeProxyCode) {
    super(code);
    this.name = "Refusal";
  }
}

// Thrown only once the request has been sent to the provider.
export class ProviderAnswerTooLarge extends Error {
  constructor() {
    super("provider_answer_too_large");
    this.name = "ProviderAnswerTooLarge";
  }
}
