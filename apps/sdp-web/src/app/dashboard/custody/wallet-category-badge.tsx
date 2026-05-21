import { Shield, Zap } from "lucide-react";
import {
  WALLET_PROVIDER_CATEGORY_DETAILS,
  type WalletProviderCategory,
} from "@/app/dashboard/custody/provider-catalog";
import { cn } from "@/lib/utils";

interface WalletCategoryBadgeProps {
  category: WalletProviderCategory;
  compact?: boolean;
  className?: string;
}

const categoryTextClassNames: Record<WalletProviderCategory, string> = {
  server: "text-[#0b6fb8]",
  institutional: "text-[#a45113]",
};

const compactCategoryBackgroundClassNames: Record<WalletProviderCategory, string> = {
  server: "bg-[#d9efff]",
  institutional: "bg-[#ffe3b8]",
};

export function WalletCategoryBadge({
  category,
  compact = false,
  className,
}: WalletCategoryBadgeProps) {
  const Icon = category === "server" ? Zap : Shield;
  const label = WALLET_PROVIDER_CATEGORY_DETAILS[category].label;

  return (
    <span
      className={cn(
        "inline-flex items-center justify-center gap-1.5 font-medium",
        categoryTextClassNames[category],
        compact
          ? cn("h-8 w-8 rounded-lg p-0", compactCategoryBackgroundClassNames[category])
          : "h-8 text-xs",
        className
      )}
      title={label}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
      {compact ? <span className="sr-only">{label}</span> : label}
    </span>
  );
}
