"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { ActionExecutionResult } from "./token-management-workspace.types";
import { stringifyBody } from "./token-management-workspace.utils";

interface TokenActionResponseCardProps {
  result: ActionExecutionResult | null;
}

export function TokenActionResponseCard({ result }: TokenActionResponseCardProps) {
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>Last Action Response</CardTitle>
        <CardDescription>Most recent API payload for admin action execution.</CardDescription>
      </CardHeader>
      <CardContent>
        {result ? (
          <div className="space-y-2">
            <p className={result.ok ? "text-sm text-[#0f9b58]" : "text-sm text-[#8a1f2a]"}>
              {result.message}
            </p>
            <pre className="max-h-[320px] overflow-auto rounded-xl border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.03)] p-3 text-xs text-[#1c1c1d]">
              {stringifyBody(result.body)}
            </pre>
          </div>
        ) : (
          <p className="text-sm text-[rgba(28,28,29,0.68)]">
            Select and run an action to inspect response data.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
