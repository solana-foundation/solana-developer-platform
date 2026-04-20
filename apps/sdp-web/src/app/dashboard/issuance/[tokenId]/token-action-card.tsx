"use client";

import type { ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface TokenActionCardProps {
  title: string;
  description?: string;
  children: ReactNode;
}

export function TokenActionCard({ title, description, children }: TokenActionCardProps) {
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
