"use client";

import React from "react";

export function HowItWorks({ children }: { children: React.ReactNode }) {
  return <div className="hiw-root">{children}</div>;
}

export function Step({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: React.ReactNode;
}) {
  const body: React.ReactNode[] = [];
  const panels: React.ReactNode[] = [];

  React.Children.forEach(children, (child) => {
    if (React.isValidElement(child) && (child.type as typeof StepPanel).isStepPanel) {
      panels.push(child);
    } else if (typeof child !== "string" || child.trim()) {
      body.push(child);
    }
  });

  return (
    <div className="hiw-step" id={`step-${number}`}>
      <div className="hiw-step-header">
        <span className="hiw-step-num" aria-hidden="true">
          {number}
        </span>
        <h3 className="hiw-step-title">{title}</h3>
      </div>
      {body.length > 0 && <div className="hiw-step-body">{body}</div>}
      {panels}
    </div>
  );
}

export const StepPanel = Object.assign(
  function StepPanel({ children }: { children: React.ReactNode }) {
    return <div className="hiw-step-panel">{children}</div>;
  },
  { isStepPanel: true as const }
);
