import type { EarnDeclaredStrategySupport } from "../../types";
import { StubEarnClient } from "../stub";

/** Veda vault-infra client — `StubEarnClient` scaffold until the integration lands. */
export class VedaEarnClient extends StubEarnClient {
  readonly provider = "veda" as const;
  readonly declaredSupport: EarnDeclaredStrategySupport = {
    sourceKinds: ["defi", "rwa"],
    depositTokens: ["USDC", "USDG", "USDT"],
  };
}
