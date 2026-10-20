"use client";

import { Button } from "@sdp/ui/button";
import { Label } from "@sdp/ui/label";
import { Textarea } from "@sdp/ui/textarea";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { useTranslations } from "@/i18n/provider";
import { saveOrganizationIpAllowlistAction } from "./organization-access-actions";

export function OrganizationIpAllowlistForm({
  initialAllowedIps,
}: {
  initialAllowedIps: string[];
}) {
  const t = useTranslations();
  const [value, setValue] = useState(() => initialAllowedIps.join("\n"));
  // One key per edit: a retried save repeats it, a changed list gets a new one.
  const idempotencyKey = useRef<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const save = () => {
    startTransition(async () => {
      idempotencyKey.current ??= crypto.randomUUID();
      const result = await saveOrganizationIpAllowlistAction(value, idempotencyKey.current);
      if (!result.ok) {
        toast.error(t("Shared.organizationAccess.saveFailed", { error: result.error }));
        return;
      }
      // Show the list as the API stored it: each entry in canonical form.
      setValue(result.allowedIps.join("\n"));
      idempotencyKey.current = null;
      toast.success(t("Shared.organizationAccess.saved"));
    });
  };

  return (
    <div className="space-y-3">
      <div>
        <Label htmlFor="organization-allowed-ips">
          {t("Shared.organizationAccess.allowedIpsLabel")}
        </Label>
        <Textarea
          id="organization-allowed-ips"
          className="mt-2"
          rows={4}
          value={value}
          onChange={(event) => {
            setValue(event.currentTarget.value);
            idempotencyKey.current = null;
          }}
          placeholder={"203.0.113.10\n198.51.100.0/24"}
          aria-describedby="organization-allowed-ips-helper"
          spellCheck={false}
          disabled={isPending}
        />
        <p id="organization-allowed-ips-helper" className="mt-2 text-xs text-secondary">
          {t("Shared.organizationAccess.allowedIpsHelper")}
        </p>
      </div>
      <Button type="button" onClick={save} disabled={isPending}>
        {isPending ? t("Shared.organizationAccess.saving") : t("Shared.organizationAccess.save")}
      </Button>
    </div>
  );
}
