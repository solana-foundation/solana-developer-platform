import type { OrganizationRpcProvider } from "@sdp/types";
import Image from "next/image";

const RPC_PROVIDER_LOGOS: Record<
  Exclude<OrganizationRpcProvider, "default">,
  { src: string; backgroundClassName: string; paddingClassName: string }
> = {
  alchemy: {
    src: "/provider-logos/alchemy.svg",
    backgroundClassName: "bg-[white]",
    paddingClassName: "p-0.5",
  },
  helius: {
    src: "/provider-logos/helius.svg",
    backgroundClassName: "bg-[white]",
    paddingClassName: "p-0.5",
  },
  quicknode: {
    src: "/provider-logos/quicknode.svg",
    backgroundClassName: "bg-[#080b09]",
    paddingClassName: "p-1",
  },
  triton: {
    src: "/provider-logos/triton.svg",
    backgroundClassName: "bg-[#060a14]",
    paddingClassName: "p-0",
  },
  validationcloud: {
    src: "/provider-logos/validation-cloud.svg",
    backgroundClassName: "bg-[#d63d57]",
    paddingClassName: "p-0",
  },
};

export function RpcProviderMark({
  provider,
}: {
  provider: Exclude<OrganizationRpcProvider, "default">;
}) {
  const logo = RPC_PROVIDER_LOGOS[provider];

  return (
    <span
      className={`relative inline-flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border-subtle ${logo.backgroundClassName}`}
      aria-hidden="true"
    >
      {provider === "triton" ? (
        <Image
          src={logo.src}
          alt=""
          width={129}
          height={36}
          className="absolute top-[-4px] left-[-4px] h-9 w-auto max-w-none"
        />
      ) : (
        <span className={`relative h-full w-full ${logo.paddingClassName}`}>
          <Image src={logo.src} alt="" fill sizes="28px" className="object-contain" />
        </span>
      )}
    </span>
  );
}
