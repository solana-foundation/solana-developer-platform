import type { SafeProxyCode } from "@sdp/safe-proxy-endpoints/protocol";

// Thrown only while nothing has been sent to the provider.
export class Refusal extends Error {
  constructor(public readonly code: SafeProxyCode) {
    super(code);
    this.name = "Refusal";
  }
}
