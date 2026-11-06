import { cn } from "@sdp/ui/cn";
import { KeyRoundIcon } from "lucide-react";
import Image from "next/image";
import type { BrandMark } from "@/lib/provider-brand-marks";

interface BrandMarkSize {
  box: string;
  logo: number;
}

const BRAND_MARK_SIZES = {
  list: { box: "size-10", logo: 24 },
  page: { box: "size-12", logo: 28 },
} as const satisfies Record<string, BrandMarkSize>;

/** A provider's round brand mark: its logo centred on its brand colour. */
export function ProviderBrandMark({
  mark,
  size,
}: {
  mark: BrandMark | null;
  size: keyof typeof BRAND_MARK_SIZES;
}) {
  const { box, logo } = BRAND_MARK_SIZES[size];
  const markClass = cn(
    "relative inline-flex shrink-0 items-center justify-center rounded-full",
    box
  );
  if (mark === null) {
    return (
      <span aria-hidden className={cn(markClass, "bg-fill-strong")}>
        <KeyRoundIcon className="size-5 text-secondary" />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className={cn(markClass, mark.ringed && "ring-1 ring-border-subtle ring-inset")}
      style={{ backgroundColor: mark.background }}
    >
      <Image src={mark.logo} alt="" width={logo} height={logo} className="object-contain" />
    </span>
  );
}
