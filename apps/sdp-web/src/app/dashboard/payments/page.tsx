import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PaymentsWorkspace } from "./payments-workspace";

export default function PaymentsPage() {
  return (
    <div className="w-full max-w-5xl flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Payments</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-[rgba(28,28,29,0.72)]">
          Manage destination-address allowlists and submit transfers from the dashboard.
        </CardContent>
      </Card>

      <PaymentsWorkspace />
    </div>
  );
}
