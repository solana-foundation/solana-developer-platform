import { cn } from "@/lib/utils";

type SkeletonBlockProps = {
  className?: string;
};

export function SkeletonBlock({ className }: SkeletonBlockProps) {
  return <div className={cn("animate-pulse rounded-md bg-border-light", className)} />;
}
