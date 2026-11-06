import type { IntegrationProviderIdentity } from "@/app/(session)/dashboard/[projectId]/integrations/integration-detail";
import {
  COMPLIANCE_BRAND_MARKS,
  CUSTODY_BRAND_MARKS,
  ProviderBrandMark,
  RAMP_BRAND_MARKS,
} from "@/lib/provider-brand-marks";

/** A provider's 48px mark, beside its name in the page header. */
export function IntegrationProviderMark({ identity }: { identity: IntegrationProviderIdentity }) {
  switch (identity.family) {
    case "custody":
      return <ProviderBrandMark size="page" mark={CUSTODY_BRAND_MARKS[identity.provider]} />;
    case "ramps":
      return <ProviderBrandMark size="page" mark={RAMP_BRAND_MARKS[identity.provider]} />;
    case "compliance":
      return <ProviderBrandMark size="page" mark={COMPLIANCE_BRAND_MARKS[identity.provider]} />;
    default: {
      const exhaustive: never = identity;
      throw new Error(`Unknown integration family: ${String(exhaustive)}`);
    }
  }
}
