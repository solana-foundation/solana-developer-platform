"use client";

import { Input } from "@sdp/ui/input";

function GeneratedApiKeyInput({ value }: { value: string }) {
  return (
    <Input
      id="generated-key"
      readOnly
      value={value}
      className="font-mono text-xs"
      onFocus={(event) => event.currentTarget.select()}
    />
  );
}

export { GeneratedApiKeyInput };
