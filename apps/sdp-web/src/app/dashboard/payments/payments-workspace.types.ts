import type { ComplianceProviderResult } from "@/lib/compliance";

export interface ComplianceSnapshot {
  address: string;
  checkedAt: string;
  providers: ComplianceProviderResult[];
}
