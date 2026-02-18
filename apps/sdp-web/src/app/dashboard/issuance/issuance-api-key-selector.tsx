"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";

export function IssuanceApiKeySelector() {
  const { issuanceApiKeys, selectedIssuanceApiKeyId, setSelectedIssuanceApiKeyId } =
    useDashboardWorkspace();

  if (issuanceApiKeys.length === 0) {
    return (
      <div className="inline-flex h-9 items-center rounded-[10px] border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.03)] px-3 text-xs text-[rgba(28,28,29,0.56)]">
        No API keys
      </div>
    );
  }

  return (
    <Select
      value={selectedIssuanceApiKeyId ?? issuanceApiKeys[0].id}
      onValueChange={(value) => setSelectedIssuanceApiKeyId(value)}
    >
      <SelectTrigger className="h-9 min-w-[220px] rounded-[10px] border-[rgba(28,28,29,0.16)] bg-white text-xs">
        <SelectValue placeholder="Select API key" />
      </SelectTrigger>
      <SelectContent>
        {issuanceApiKeys.map((apiKey) => (
          <SelectItem key={apiKey.id} value={apiKey.id}>
            {apiKey.name} ({apiKey.keyPrefix})
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
