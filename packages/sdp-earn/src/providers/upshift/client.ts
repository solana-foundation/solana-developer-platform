import type { EarnDeclaredStrategySupport } from "../../types";
import { StubEarnClient } from "../stub";

/** Upshift vault-infra client — `StubEarnClient` scaffold until the integration lands. */
export class UpshiftEarnClient extends StubEarnClient {
  readonly provider = "upshift" as const;
  readonly declaredSupport: EarnDeclaredStrategySupport = {
    sourceKinds: ["defi", "rwa"],
    depositTokens: ["USDC", "USDG", "USDT"],
  };
}
