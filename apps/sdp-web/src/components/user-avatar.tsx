import { cn } from "@/lib/utils";

/**
 * Derives up to two initials from a person's display label — first letter of
 * the first two words for names, first letter for single-word labels such as
 * email addresses.
 *
 * @param name - The person's display label.
 * @returns One or two uppercase characters.
 */
function initialsFromName(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return `${words[0][0]}${words[1][0]}`.toUpperCase();
  return name.trim().slice(0, 1).toUpperCase();
}

/**
 * Default person avatar: a filled circle showing the user's initials.
 *
 * @param props.name - The person's display label the initials derive from.
 * @param props.className - Extra classes merged onto the circle.
 * @returns The avatar element.
 */
export function UserAvatar({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-on-primary",
        className
      )}
    >
      {initialsFromName(name)}
    </span>
  );
}
