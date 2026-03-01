import type { Env } from "@/types/env";
import { ChainalysisComplianceProvider } from "./providers/chainalysis";
import { EllipticComplianceProvider } from "./providers/elliptic";
import { RangeComplianceProvider } from "./providers/range";
import { TrmComplianceProvider } from "./providers/trm";
import type {
  ComplianceAddressScreeningInput,
  ComplianceProvider,
  ComplianceProviderResult,
} from "./types";

export class ComplianceService {
  constructor(private readonly providers: ComplianceProvider[]) {}

  async screenAddress(input: ComplianceAddressScreeningInput): Promise<ComplianceProviderResult[]> {
    return Promise.all(this.providers.map((provider) => provider.screenAddress(input)));
  }
}

export function createComplianceService(env: Env): ComplianceService {
  const providers: ComplianceProvider[] = [
    new RangeComplianceProvider({
      apiKey: env.RANGE_API_KEY,
      baseUrl: env.RANGE_API_BASE_URL,
    }),
    new EllipticComplianceProvider({
      apiToken: env.ELLIPTIC_API_TOKEN,
      apiKey: env.ELLIPTIC_API_KEY,
      apiSecret: env.ELLIPTIC_API_SECRET,
      baseUrl: env.ELLIPTIC_API_BASE_URL,
    }),
    new TrmComplianceProvider({
      apiKey: env.TRM_API_KEY,
      baseUrl: env.TRM_API_BASE_URL,
    }),
    new ChainalysisComplianceProvider({
      apiKey: env.CHAINALYSIS_API_KEY,
      baseUrl: env.CHAINALYSIS_API_BASE_URL,
    }),
  ];

  return new ComplianceService(providers);
}
