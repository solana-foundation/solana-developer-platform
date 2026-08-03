import type { EarnDeclaredStrategySupport } from "../../types";
import { StubEarnClient } from "../stub";

/** Ground vault-infra client — `StubEarnClient` scaffold until the integration lands. */
export class GroundEarnClient extends StubEarnClient {
  readonly provider = "ground" as const;
  readonly declaredSupport: EarnDeclaredStrategySupport = {
    sourceKinds: ["defi", "rwa"],
    depositTokens: ["USDC", "USDG", "USDT"],
  };
}
