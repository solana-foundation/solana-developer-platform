import Image from "next/image";
import type { IntegrationProviderIdentity } from "@/app/(session)/dashboard/[projectId]/integrations/integration-detail";
import { WalletProviderMark } from "@/app/(session)/dashboard/[projectId]/wallets/wallet-provider-mark";
import { COMPLIANCE_PROVIDER_LOGOS } from "@/lib/compliance";
import { RAMP_PROVIDER_LOGOS } from "@/lib/ramps";

/** A provider's 48px mark, beside its name in the page header. */
export function IntegrationProviderMark({ identity }: { identity: IntegrationProviderIdentity }) {
  if (identity.family === "custody") {
    return <WalletProviderMark provider={identity.provider} size="page" />;
  }
  const src =
    identity.family === "ramps"
      ? RAMP_PROVIDER_LOGOS[identity.provider]
      : COMPLIANCE_PROVIDER_LOGOS[identity.provider];
  return (
    <span
      aria-hidden
      className="relative inline-flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[white] p-2.5"
    >
      <span className="relative h-full w-full">
        <Image src={src} alt="" fill sizes="48px" className="object-contain" />
      </span>
    </span>
  );
}
