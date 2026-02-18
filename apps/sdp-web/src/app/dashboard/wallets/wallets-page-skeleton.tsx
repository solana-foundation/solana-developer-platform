import { Card, CardContent, CardHeader } from "@/components/ui/card";

function SkeletonLine({ widthClass = "w-full" }: { widthClass?: string }) {
  return <div className={`h-4 rounded bg-[rgba(28,28,29,0.10)] ${widthClass}`} />;
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
    <Card className="min-h-[300px] animate-pulse">
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
    <Card className="min-h-[284px] animate-pulse">
      <CardHeader className="space-y-3">
        <SkeletonLine widthClass="w-44" />
        <SkeletonLine widthClass="w-[54%]" />
      </CardHeader>
      <CardContent className="space-y-4">
        <SkeletonRows rows={4} />
        <div className="h-10 w-36 rounded-[10px] bg-[rgba(28,28,29,0.10)]" />
      </CardContent>
    </Card>
  );
}

export function WalletsTableSectionSkeleton() {
  return (
    <Card className="min-h-[360px] animate-pulse">
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
    <div className="w-full max-w-5xl flex flex-col gap-6">
      <WalletsOnboardingSkeleton />
      <WalletsSigningConfigSkeleton />
      <WalletsTableSectionSkeleton />
    </div>
  );
}
