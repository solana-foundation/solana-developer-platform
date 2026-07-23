"use client";

import type { ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface TokenActionCardProps {
  title: string;
  description?: string;
  children: ReactNode;
  // "card" (default): legacy DS-card chrome. "flat": 1px-border panel matching the
  // AdvancedSettingsEditor. "bare": no chrome, for when a parent already provides
  // the framed card (avoids a card-in-card). flat/bare are asset-profiles only.
  variant?: "card" | "flat" | "bare";
}

export function TokenActionCard({
  title,
  description,
  children,
  variant = "card",
}: TokenActionCardProps) {
  if (variant === "flat" || variant === "bare") {
    return (
      // Only "flat" draws the panel chrome; "bare" relies on an outer card.
      <div
        className={
          variant === "flat"
            ? "rounded-2xl border border-border-default bg-surface-raised p-5"
            : undefined
        }
      >
        <div>
          <p className="text-base font-medium text-primary">{title}</p>
          {description ? <p className="mt-1 text-sm text-tertiary">{description}</p> : null}
        </div>
        <div className="mt-4 space-y-4">{children}</div>
      </div>
    );
  }

  return (
    <Card className="gap-4">
      <CardHeader className="gap-1.5">
        <CardTitle className="text-[17px] leading-6">{title}</CardTitle>
        {description ? (
          <CardDescription className="text-[13px] leading-5">{description}</CardDescription>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}
