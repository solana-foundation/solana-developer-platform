import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function DashboardMembersPage() {
  return (
    <div className="w-full max-w-5xl flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Coming soon</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-secondary">
          Member management will be available in a future update.
        </CardContent>
      </Card>
    </div>
  );
}
