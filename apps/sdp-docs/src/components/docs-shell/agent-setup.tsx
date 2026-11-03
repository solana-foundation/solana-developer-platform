"use client";

import { Popover, PopoverContent, PopoverTrigger } from "fumadocs-ui/components/ui/popover";
import { ChevronDown } from "lucide-react";
import { Fragment, type KeyboardEvent, useId, useState } from "react";
import type { AgentSetupOption, AgentSetupOptions } from "@/lib/agent-setup";
import { CopyStatusAnnouncement, CopyStatusIcon, useCopyStatus } from "./copy-status";

// Left and Right move between tabs and select, as the WAI-ARIA tabs pattern does.
const TAB_KEY_STEPS: Partial<Record<string, 1 | -1>> = { ArrowRight: 1, ArrowLeft: -1 };

/**
 * A command that wraps only between words and after a slash, never inside `--agent` or
 * `sdp-docs`. `<wbr>` adds no character, so selecting the text still copies the command.
 */
function Command({ text }: { text: string }) {
  return text.split(" ").map((word, index) => {
    const parts = word.split("/");
    return (
      <Fragment key={word}>
        {index > 0 ? " " : null}
        {parts.map((part, partIndex) => (
          <Fragment key={part}>
            {partIndex > 0 ? <wbr /> : null}
            <span className="launch-agent-setup-word">
              {partIndex < parts.length - 1 ? `${part}/` : part}
            </span>
          </Fragment>
        ))}
      </Fragment>
    );
  });
}

/** One tab's panel: its command and a copy button with its own copy state. */
function CommandPanel({
  option,
  tabId,
  panelId,
  hidden,
}: {
  option: AgentSetupOption;
  tabId: string;
  panelId: string;
  hidden: boolean;
}) {
  const copy = useCopyStatus();
  return (
    <div
      role="tabpanel"
      id={panelId}
      aria-labelledby={tabId}
      hidden={hidden}
      className="launch-agent-setup-panel"
    >
      <code className="launch-agent-setup-command">
        <Command text={option.command} />
      </code>
      <button
        type="button"
        className="launch-agent-setup-copy"
        aria-label={`Copy the ${option.label} command`}
        onClick={() => copy.run(() => navigator.clipboard.writeText(option.command))}
      >
        <CopyStatusIcon status={copy.status} />
      </button>
      <CopyStatusAnnouncement
        status={copy.status}
        copied="Command copied"
        failed="Couldn't copy the command"
      />
    </div>
  );
}

/**
 * The sidebar's Agent setup menu: one tab per coding agent, each a copyable command that
 * installs the docs skill. The layout builds the commands for its release channel.
 */
export function AgentSetup({ options }: { options: AgentSetupOptions }) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const id = useId();
  const tabId = (index: number) => `${id}-tab-${index}`;
  const panelId = (index: number) => `${id}-panel-${index}`;

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = TAB_KEY_STEPS[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const next = (selectedIndex + step + options.length) % options.length;
    setSelectedIndex(next);
    document.getElementById(tabId(next))?.focus();
  };

  return (
    <Popover>
      <PopoverTrigger className="launch-docs-sidebar-action">
        Agent setup
        <ChevronDown className="launch-chevron" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent align="start" className="launch-popover launch-agent-setup">
        <p className="launch-agent-setup-title">Set up your coding agent</p>
        <p className="launch-agent-setup-description">
          Install the SDP docs skill, so your agent works from the published docs and follows the
          rules for building on SDP.
        </p>
        <div
          role="tablist"
          aria-label="Coding agent"
          className="launch-agent-setup-tabs"
          onKeyDown={onTabKeyDown}
        >
          {options.map((option, index) => (
            <button
              key={option.id}
              type="button"
              role="tab"
              id={tabId(index)}
              aria-selected={index === selectedIndex}
              aria-controls={panelId(index)}
              tabIndex={index === selectedIndex ? 0 : -1}
              className="launch-agent-setup-tab"
              onClick={() => setSelectedIndex(index)}
            >
              {option.label}
            </button>
          ))}
        </div>
        {options.map((option, index) => (
          <CommandPanel
            key={option.id}
            option={option}
            tabId={tabId(index)}
            panelId={panelId(index)}
            hidden={index !== selectedIndex}
          />
        ))}
      </PopoverContent>
    </Popover>
  );
}
