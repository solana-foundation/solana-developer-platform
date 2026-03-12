import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { SkeletonBlock } from "@/components/ui/skeleton-block";

function SkeletonLine({ widthClass = "w-full" }: { widthClass?: string }) {
  return <SkeletonBlock className={`h-4 rounded-[4px] ${widthClass}`} />;
}

function SkeletonRows({ rows }: { rows: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }, (_, idx) => (
        <SkeletonLine
          key={`row-skeleton-${idx + 1}`}
          widthClass={idx % 2 === 0 ? "w-[92%]" : "w-[76%]"}
        />
      ))}
    </div>
  );
}

export function WalletsOnboardingSkeleton() {
  return (
    <Card className="min-h-[300px]">
      <CardHeader className="space-y-3">
        <SkeletonLine widthClass="w-56" />
        <SkeletonLine widthClass="w-[72%]" />
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-xl border border-[rgba(28,28,29,0.08)] bg-[rgba(28,28,29,0.04)] p-4">
          <SkeletonRows rows={3} />
        </div>
        <SkeletonLine widthClass="w-[48%]" />
      </CardContent>
    </Card>
  );
}

export function WalletsSigningConfigSkeleton() {
  return (
    <Card className="min-h-[284px]">
      <CardHeader className="space-y-3">
        <SkeletonLine widthClass="w-44" />
        <SkeletonLine widthClass="w-[54%]" />
      </CardHeader>
      <CardContent className="space-y-4">
        <SkeletonRows rows={4} />
        <SkeletonBlock className="h-10 w-36 rounded-[10px]" />
      </CardContent>
    </Card>
  );
}

export function WalletsTableSectionSkeleton() {
  return (
    <Card className="min-h-[360px]">
      <CardHeader className="space-y-3">
        <SkeletonLine widthClass="w-20" />
        <SkeletonLine widthClass="w-[46%]" />
      </CardHeader>
      <CardContent className="space-y-3">
        <SkeletonRows rows={5} />
      </CardContent>
    </Card>
  );
}

export function WalletsPageSkeleton() {
  return (
    <div className="w-full flex flex-col gap-6">
      <WalletsOnboardingSkeleton />
      <WalletsSigningConfigSkeleton />
      <WalletsTableSectionSkeleton />
    </div>
  );
}
