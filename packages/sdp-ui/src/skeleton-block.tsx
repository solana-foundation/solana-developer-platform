import { cn } from "./cn";

type SkeletonBlockProps = {
  className?: string;
};

export function SkeletonBlock({ className }: SkeletonBlockProps) {
  return (
    <div
      className={cn(
        "animate-pulse rounded-md bg-fill-strong motion-reduce:animate-none",
        className
      )}
    />
  );
}
