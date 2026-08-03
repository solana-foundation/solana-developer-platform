export type { PrivateChannelInstance, PrivateChannelInstanceInput } from "@sdp/types";

// The user-editable configuration matches the API input shape one-for-one.
// Kept as a local alias so package consumers don't need @sdp/types just to read
// `SANDBOX_DEFAULTS`.
export type PrivateChannelInstanceConfig = import("@sdp/types").PrivateChannelInstanceInput;

/** Result of a gateway REST liveness/readiness probe (`/health`, `/ready`). */
export interface GatewayHealth {
  /** True when the endpoint returned a 2xx. */
  ok: boolean;
  /** The HTTP status code (0 when the request never completed). */
  status: number;
}
