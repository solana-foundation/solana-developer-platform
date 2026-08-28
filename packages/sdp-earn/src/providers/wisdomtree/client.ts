import type { EarnDeclaredStrategySupport } from "../../types";
import { StubEarnClient } from "../stub";

/**
 * WisdomTree Connect vault-infra client — `StubEarnClient` scaffold; the
 * catalogue read lands in the follow-up change.
 *
 * WisdomTree fronts tokenized SEC-registered funds (Token-2022 mints with a
 * compliance transfer hook — see `@sdp/types/wisdomtree-programs`), so the
 * envelope is `rwa`, and subscriptions settle in USDC only: the Connect API's
 * non-USD order flow is USDC-denominated, and USD (bank SSI) settlement is not
 * a rail SDP fronts.
 */
export class WisdomTreeEarnClient extends StubEarnClient {
  readonly provider = "wisdomtree" as const;
  readonly declaredSupport: EarnDeclaredStrategySupport = {
    sourceKinds: ["rwa"],
    depositTokens: ["USDC"],
  };
}
