"use client";

import { Braces, Hexagon, Link2, Lock, type LucideIcon, Target } from "lucide-react";

interface InfoStep {
  icon: LucideIcon;
  title: string;
  description: string;
}

// Explains the Asset Profile data model (profile -> metadata -> public
// projection -> token URI) alongside the classification step.
const STEPS: InfoStep[] = [
  {
    icon: Hexagon,
    title: "Asset Profile",
    description: "You select the category and type. SDP stores your canonical issuance metadata.",
  },
  {
    icon: Braces,
    title: "Issuance Metadata",
    description: "Includes asset, compliance, chain, and custom (customer/integration) fields.",
  },
  {
    icon: Target,
    title: "Public Projection",
    description: "SDP projects a safe public subset to token metadata.",
  },
  {
    icon: Link2,
    title: "Token Metadata URI",
    description: "SDP hosts the default URI that returns only the public metadata.",
  },
];

export function ClassificationInfoRail() {
  return (
    <aside className="lg:sticky lg:top-4">
      <div className="rounded-2xl border border-[rgba(28,28,29,0.1)] bg-white p-5">
        <p className="text-base font-medium text-[#1c1c1d]">How this works</p>

        <ul className="mt-4 space-y-4">
          {STEPS.map((step) => {
            const Icon = step.icon;
            return (
              <li key={step.title} className="flex items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[rgba(28,28,29,0.05)] text-[rgba(28,28,29,0.7)]">
                  <Icon className="h-4 w-4" />
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-[#1c1c1d]">{step.title}</p>
                  <p className="mt-0.5 text-sm text-[rgba(28,28,29,0.58)]">{step.description}</p>
                </div>
              </li>
            );
          })}
        </ul>

        <div className="mt-5 flex items-start gap-2.5 rounded-xl border border-[rgba(28,28,29,0.08)] bg-[rgba(28,28,29,0.02)] p-3">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-[rgba(28,28,29,0.5)]" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-[#1c1c1d]">Private by default</p>
            <p className="mt-0.5 text-xs text-[rgba(28,28,29,0.58)]">
              Compliance and custom metadata stay private unless explicitly included in the public
              metadata projection.
            </p>
          </div>
        </div>
      </div>
    </aside>
  );
}
