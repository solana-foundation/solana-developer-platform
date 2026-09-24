import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * A tinted, borderless tile that starts a flow: icon at the top, name and a one-line promise
 * at the bottom. Flat by design; hover deepens the tint.
 */
export function ActionTile({
  href,
  icon: Icon,
  label,
  description,
  className,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  description: string;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "flex min-h-28 min-w-0 flex-col justify-between gap-6 rounded-control bg-fill-subtle p-4 transition-colors hover:bg-fill focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary motion-reduce:transition-none",
        className
      )}
    >
      <Icon className="size-6 text-secondary" strokeWidth={1.5} aria-hidden="true" />
      <span className="min-w-0">
        <span className="block text-body font-medium text-primary">{label}</span>
        <span className="block text-meta text-secondary">{description}</span>
      </span>
    </Link>
  );
}
