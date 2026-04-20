"use client";

import {
  Tooltip as SolanaTooltip,
  TooltipProvider as SolanaTooltipProvider,
} from "@solana/design-system/tooltip";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";

import { cn } from "@/lib/utils";

type TooltipProviderProps = {
  children: ReactNode;
  delayDuration?: number;
};

type TooltipProps = {
  children: ReactNode;
};

type TooltipTriggerProps = {
  asChild?: boolean;
  children: ReactNode;
};

type TooltipContentProps = {
  align?: "start" | "center" | "end";
  children: ReactNode;
  className?: string;
  side?: "top" | "bottom" | "left" | "right";
  sideOffset?: number;
};

function getSingleTriggerElement(children: ReactNode): ReactElement | null {
  const childElements = Children.toArray(children).filter(isValidElement);
  return childElements.length === 1 ? childElements[0] : null;
}

function TooltipProvider({ children, delayDuration = 120 }: TooltipProviderProps) {
  return <SolanaTooltipProvider delay={delayDuration}>{children}</SolanaTooltipProvider>;
}

function Tooltip({ children }: TooltipProps) {
  const childElements = Children.toArray(children).filter(isValidElement);
  const trigger = childElements.find(
    (child): child is ReactElement<TooltipTriggerProps> => child.type === TooltipTrigger
  );
  const content = childElements.find(
    (child): child is ReactElement<TooltipContentProps> => child.type === TooltipContent
  );

  if (!trigger || !content) {
    return <>{children}</>;
  }

  const triggerElement = trigger.props.asChild ? (
    getSingleTriggerElement(trigger.props.children)
  ) : (
    <button className="inline-flex" type="button">
      {trigger.props.children}
    </button>
  );

  if (!triggerElement) {
    return <>{children}</>;
  }

  const contentNode = (
    <span className={cn("block", content.props.className)}>{content.props.children}</span>
  );

  return (
    <SolanaTooltip
      align={content.props.align}
      content={contentNode}
      side={content.props.side}
      sideOffset={content.props.sideOffset}
    >
      {triggerElement}
    </SolanaTooltip>
  );
}

function TooltipTrigger({ children }: TooltipTriggerProps) {
  return <>{children}</>;
}

function TooltipContent(_props: TooltipContentProps) {
  return null;
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
