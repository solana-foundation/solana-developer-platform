import { cn } from "@/lib/utils";

type SkeletonBlockProps = {
  className?: string;
};

export function SkeletonBlock({ className }: SkeletonBlockProps) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "animate-pulse rounded-[12px] bg-[rgba(28,28,29,0.08)] motion-reduce:animate-none",
        className
      )}
    />
  );
}
