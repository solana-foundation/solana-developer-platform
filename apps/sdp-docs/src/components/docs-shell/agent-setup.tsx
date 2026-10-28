"use client";

import { Popover, PopoverContent, PopoverTrigger } from "fumadocs-ui/components/ui/popover";
import { ChevronDown } from "lucide-react";
import { Fragment, type KeyboardEvent, useId, useState } from "react";
import type { AgentSetupOption } from "@/lib/agent-setup";
import { CopyStatusAnnouncement, CopyStatusIcon, useCopyStatus } from "./copy-status";

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

/**
 * The sidebar's Agent setup menu: one tab per coding agent, each a copyable command that
 * installs the docs skill. The layout builds the commands for its release channel.
 */
export function AgentSetup({ options }: { options: readonly AgentSetupOption[] }) {
  const [selectedId, setSelectedId] = useState(options[0]?.id);
  const copy = useCopyStatus();
  const id = useId();
  const selected = options.find((option) => option.id === selectedId) ?? options[0];

  if (!selected) return null;

  const select = (option: AgentSetupOption) => {
    setSelectedId(option.id);
    copy.reset();
  };

  // Left and Right move between tabs and select, as the WAI-ARIA tabs pattern does.
  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const index = options.indexOf(selected);
    const next = options[(index + step + options.length) % options.length];
    if (!next) return;
    select(next);
    document.getElementById(`${id}-tab-${next.id}`)?.focus();
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
          {options.map((option) => (
            <button
              key={option.id}
              type="button"
              role="tab"
              id={`${id}-tab-${option.id}`}
              aria-selected={option.id === selected.id}
              aria-controls={`${id}-panel`}
              tabIndex={option.id === selected.id ? 0 : -1}
              className="launch-agent-setup-tab"
              onClick={() => select(option)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div
          role="tabpanel"
          id={`${id}-panel`}
          aria-labelledby={`${id}-tab-${selected.id}`}
          className="launch-agent-setup-panel"
        >
          <code className="launch-agent-setup-command">
            <Command text={selected.command} />
          </code>
          <button
            type="button"
            className="launch-agent-setup-copy"
            aria-label={`Copy the ${selected.label} command`}
            onClick={() => copy.run(() => navigator.clipboard.writeText(selected.command))}
          >
            <CopyStatusIcon status={copy.status} />
          </button>
        </div>
        <CopyStatusAnnouncement
          status={copy.status}
          copied="Command copied"
          failed="Couldn't copy the command"
        />
      </PopoverContent>
    </Popover>
  );
}
