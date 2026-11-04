import type { UserResource } from "@clerk/nextjs/types";
import { cn } from "@sdp/ui/cn";

export function userDisplayName(user: UserResource): string | undefined {
  const joinedName = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return user.fullName || joinedName || user.username || user.primaryEmailAddress?.emailAddress;
}

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
        className={cn("size-7 shrink-0 rounded-full object-cover refresh:size-8", className)}
        aria-hidden="true"
      />
    );
  }
  return (
    <span
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-on-primary refresh:size-8 refresh:text-meta refresh:font-medium",
        className
      )}
    >
      {(name ?? "").trim().slice(0, 2).toUpperCase() || "?"}
    </span>
  );
}
