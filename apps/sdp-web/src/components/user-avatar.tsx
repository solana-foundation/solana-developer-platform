import { cn } from "@sdp/ui/cn";

export function UserAvatar({
  name,
  imageUrl,
  className,
}: {
  name: string | undefined;
  imageUrl: string;
  className?: string;
}) {
  if (imageUrl) {
    return (
      // biome-ignore lint/performance/noImgElement: Clerk provides external URLs not in next/image config.
      <img
        src={imageUrl}
        alt=""
        className={cn("shrink-0 rounded-full object-cover size-8", className)}
        aria-hidden="true"
      />
    );
  }
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full bg-primary text-on-primary size-8 text-meta font-medium",
        className
      )}
    >
      {(name ?? "").trim().slice(0, 2).toUpperCase() || "?"}
    </span>
  );
}
