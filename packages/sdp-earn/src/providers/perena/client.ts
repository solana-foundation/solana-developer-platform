import type { EarnDeclaredStrategySupport } from "../../types";
import { StubEarnClient } from "../stub";

/** Perena vault-infra client — `StubEarnClient` scaffold until the integration lands. */
export class PerenaEarnClient extends StubEarnClient {
  readonly provider = "perena" as const;
  readonly declaredSupport: EarnDeclaredStrategySupport = {
    sourceKinds: ["defi"],
    depositTokens: ["USDC", "USDG", "USDT"],
  };
}
