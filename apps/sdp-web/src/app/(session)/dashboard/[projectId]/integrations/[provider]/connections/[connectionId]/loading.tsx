import { SkeletonBlock } from "@sdp/ui/skeleton-block";

const WALLET_ROW_KEYS = ["first", "second"];
const CREDENTIAL_ROW_KEYS = ["app-id", "secret", "previous"];
const DETAIL_ROW_KEYS = ["id", "project", "created"];

function RecordLinesSkeleton({ keys }: { keys: string[] }) {
  return (
    <div>
      {keys.map((key) => (
        <div
          key={key}
          className="flex h-11 items-center gap-3 border-b border-border-subtle last:border-b-0"
        >
          <SkeletonBlock className="h-4 w-24 shrink-0" />
          <SkeletonBlock className="ml-9 h-4 w-40" />
        </div>
      ))}
    </div>
  );
}

/**
 * The connection page's blocks in the page column: wallets, credentials and details, each a
 * heading over its rows, spaced as the page's loose record stack, so the layout holds still
 * when the reads land.
 */
export default function CustodyConnectionLoading() {
  return (
    <div className="flex w-full flex-col gap-12 pt-6 md:gap-20 md:pt-10" aria-busy="true">
      <div className="flex flex-col gap-4">
        <SkeletonBlock className="h-6 w-24" />
        <div>
          {WALLET_ROW_KEYS.map((key) => (
            <div
              key={key}
              className="flex items-center gap-3 border-b border-border-subtle py-3 last:border-b-0"
            >
              <SkeletonBlock className="size-8 rounded-full" />
              <div className="flex-1 space-y-1.5">
                <SkeletonBlock className="h-4 w-40" />
                <SkeletonBlock className="h-4 w-28" />
              </div>
              <SkeletonBlock className="h-4 w-24" />
            </div>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-4">
        <SkeletonBlock className="h-6 w-28" />
        <RecordLinesSkeleton keys={CREDENTIAL_ROW_KEYS} />
      </div>
      <div className="flex flex-col gap-4">
        <SkeletonBlock className="h-6 w-20" />
        <RecordLinesSkeleton keys={DETAIL_ROW_KEYS} />
      </div>
    </div>
  );
}
