import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function PaymentsPage() {
  return (
    <div className="w-full max-w-5xl flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Coming soon</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-[rgba(28,28,29,0.72)]">
          Payments workflows and transfer operations will be available here in a future update.
        </CardContent>
      </Card>
    </div>
  );
}
