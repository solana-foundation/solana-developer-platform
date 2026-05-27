"use client";

import { ArrowLeftIcon, ArrowRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCounterpartyCreate } from "../counterparty-create-context";

export function IdentityStep() {
  const { identity, goNext, goBack } = useCounterpartyCreate();
  const { values, setField, errors } = identity;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="firstName">First name</Label>
          <Input
            id="firstName"
            placeholder="Jane"
            value={values.firstName}
            onChange={(e) => setField("firstName", e.target.value)}
          />
          {errors.firstName && (
            <p className="mt-1 text-xs text-status-error-text">{errors.firstName}</p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="lastName">Last name</Label>
          <Input
            id="lastName"
            placeholder="Smith"
            value={values.lastName}
            onChange={(e) => setField("lastName", e.target.value)}
          />
          {errors.lastName && (
            <p className="mt-1 text-xs text-status-error-text">{errors.lastName}</p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="dateOfBirth">Date of birth</Label>
          <Input
            id="dateOfBirth"
            type="date"
            value={values.dateOfBirth}
            onChange={(e) => setField("dateOfBirth", e.target.value)}
          />
          {errors.dateOfBirth && (
            <p className="mt-1 text-xs text-status-error-text">{errors.dateOfBirth}</p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="phone">Phone</Label>
          <Input
            id="phone"
            type="tel"
            placeholder="+1 555 000 0000"
            value={values.phone}
            onChange={(e) => setField("phone", e.target.value)}
          />
          {errors.phone && <p className="mt-1 text-xs text-status-error-text">{errors.phone}</p>}
        </div>
      </div>

      <div className="flex items-center justify-between pt-2">
        <Button type="button" variant="outline" onClick={goBack} iconLeft={<ArrowLeftIcon />}>
          Back
        </Button>
        <Button type="button" onClick={goNext} iconRight={<ArrowRightIcon />}>
          Next
        </Button>
      </div>
    </div>
  );
}
