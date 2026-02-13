import { DashboardHeader } from "@/components/dashboard-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function DashboardAllowlistPage() {
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8">
      <DashboardHeader title="Allowlist" />

      <Card>
        <CardHeader>
          <CardTitle>Coming soon</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-[rgba(28,28,29,0.72)]">
          Allowlist management will be available in a future update.
        </CardContent>
      </Card>
    </div>
  );
}
