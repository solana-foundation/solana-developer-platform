"use client";

import { ArrowRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EntityTypeToggle } from "../components/entity-type-toggle";
import { useCounterpartyCreate } from "../counterparty-create-context";

export function BasicsStep() {
  const { basics, goNext } = useCounterpartyCreate();
  const { values, setField, errors } = basics;

  return (
    <div className="space-y-6">
      <EntityTypeToggle
        value={values.entityType}
        onChange={(next) => setField("entityType", next)}
      />

      <div className="space-y-2">
        <Label htmlFor="displayName">Display name</Label>
        <Input
          id="displayName"
          placeholder={values.entityType === "individual" ? "Jane Smith" : "Acme Corp"}
          value={values.displayName}
          onChange={(e) => setField("displayName", e.target.value)}
        />
        {errors.displayName && (
          <p className="mt-1 text-xs text-status-error-text">{errors.displayName}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          placeholder="contact@example.com"
          value={values.email}
          onChange={(e) => setField("email", e.target.value)}
        />
        {errors.email && <p className="mt-1 text-xs text-status-error-text">{errors.email}</p>}
      </div>

      <div className="space-y-2">
        <Label htmlFor="externalId">
          External ID <span className="font-normal text-text-extra-low">(optional)</span>
        </Label>
        <Input
          id="externalId"
          placeholder="your-internal-id"
          value={values.externalId}
          onChange={(e) => setField("externalId", e.target.value)}
        />
        {errors.externalId && (
          <p className="mt-1 text-xs text-status-error-text">{errors.externalId}</p>
        )}
      </div>

      <div className="flex items-center justify-end pt-2">
        <Button type="button" onClick={goNext} iconRight={<ArrowRightIcon />}>
          Next
        </Button>
      </div>
    </div>
  );
}
