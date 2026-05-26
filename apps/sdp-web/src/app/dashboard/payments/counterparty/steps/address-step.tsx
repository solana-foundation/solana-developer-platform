"use client";

import { ArrowLeftIcon, ArrowRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCounterpartyCreate } from "../counterparty-create-context";

export function AddressStep() {
  const { address, goNext, goBack } = useCounterpartyCreate();
  const { values, setField, errors } = address;

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor="line1">Line 1</Label>
        <Input
          id="line1"
          placeholder="123 Main St"
          value={values.line1}
          onChange={(e) => setField("line1", e.target.value)}
        />
        {errors.line1 && <p className="mt-1 text-xs text-status-error-text">{errors.line1}</p>}
      </div>

      <div className="space-y-2">
        <Label htmlFor="line2">
          Line 2 <span className="font-normal text-text-extra-low">(optional)</span>
        </Label>
        <Input
          id="line2"
          placeholder="Suite 400"
          value={values.line2}
          onChange={(e) => setField("line2", e.target.value)}
        />
        {errors.line2 && <p className="mt-1 text-xs text-status-error-text">{errors.line2}</p>}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="city">City</Label>
          <Input
            id="city"
            placeholder="New York"
            value={values.city}
            onChange={(e) => setField("city", e.target.value)}
          />
          {errors.city && <p className="mt-1 text-xs text-status-error-text">{errors.city}</p>}
        </div>
        <div className="space-y-2">
          <Label htmlFor="postalCode">
            Postal code <span className="font-normal text-text-extra-low">(optional)</span>
          </Label>
          <Input
            id="postalCode"
            placeholder="10001"
            value={values.postalCode}
            onChange={(e) => setField("postalCode", e.target.value)}
          />
          {errors.postalCode && (
            <p className="mt-1 text-xs text-status-error-text">{errors.postalCode}</p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="countryCode">Country code</Label>
          <Input
            id="countryCode"
            placeholder="US"
            maxLength={8}
            value={values.countryCode}
            onChange={(e) => setField("countryCode", e.target.value)}
          />
          {errors.countryCode && (
            <p className="mt-1 text-xs text-status-error-text">{errors.countryCode}</p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="subdivisionCode">
            State / Province <span className="font-normal text-text-extra-low">(optional)</span>
          </Label>
          <Input
            id="subdivisionCode"
            placeholder="NY"
            value={values.subdivisionCode}
            onChange={(e) => setField("subdivisionCode", e.target.value)}
          />
          {errors.subdivisionCode && (
            <p className="mt-1 text-xs text-status-error-text">{errors.subdivisionCode}</p>
          )}
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
