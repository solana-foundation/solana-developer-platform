import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { privateChannels } from "@/flags";

export default async function PrivateChannelsLayout({ children }: { children: ReactNode }) {
  // Every leaf page checks the flag too, but gating the shared layout avoids
  // rendering Private Channels chrome around a hand-typed disabled route.
  if (!(await privateChannels())) {
    notFound();
  }

  // The payments shell locks its viewport and clips overflow, so each segment owns
  // its own scrolling. Without this, content below the fold is unreachable.
  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Gutters match the shell's header padding, which locked routes don't inherit.
          The deep bottom padding clears the fixed mobile bar that hides at xl. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pt-6 pb-20 md:px-6 xl:pb-6">
        {children}
      </div>
    </div>
  );
}
