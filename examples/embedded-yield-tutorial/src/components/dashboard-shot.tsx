import Image from "next/image";

/**
 * Step 2 visual: the real SDP Embedded Yield dashboard page inside a faux
 * desktop browser window, drawn with plain CSS.
 */
export function DashboardShot() {
  return (
    <figure className="w-full max-w-xl">
      <div className="overflow-hidden rounded-2xl border border-foreground/10 bg-background shadow-xl shadow-foreground/10">
        <div className="flex items-center gap-2 border-b border-foreground/10 bg-app px-4 py-2.5">
          <span className="flex gap-1.5">
            <span className="size-2.5 rounded-full bg-foreground/15" />
            <span className="size-2.5 rounded-full bg-foreground/15" />
            <span className="size-2.5 rounded-full bg-foreground/15" />
          </span>
          <span className="flex-1 truncate rounded-md bg-foreground/5 px-3 py-1 text-xs text-muted-foreground">
            localhost:3000/dashboard/markets/embedded-yield
          </span>
        </div>
        <Image
          src="/sdp-embedded-yield-dashboard.jpg"
          alt="SDP dashboard, Embedded Yield page listing Earn strategies and positions"
          width={1333}
          height={871}
          className="block h-auto w-full"
        />
      </div>
      <figcaption className="mt-3 text-center text-xs text-muted-foreground">
        The SDP dashboard where the wallet team chooses the Earn strategies its
        customers can enter.
      </figcaption>
    </figure>
  );
}
