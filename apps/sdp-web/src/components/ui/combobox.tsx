"use client";

import { CheckIcon, ChevronDownIcon, SearchIcon } from "lucide-react";
import { Popover } from "radix-ui";
import {
  cloneElement,
  type Dispatch,
  isValidElement,
  type ReactNode,
  type SetStateAction,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";
import { useThemeScope, useThemeScopeAttributes } from "@/components/theme-scope";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { Badge, type BadgeVariant } from "./badge";
import { Input } from "./input";
import { Label } from "./label";
import { Modal } from "./modal";
import { usePortalContainer } from "./portal-container";

const DEFAULT_ICON_CLASS = "size-5 shrink-0 text-tertiary";

export type ComboboxSize = "md" | "lg" | "xl";
export type ComboboxVariant = "popover" | "dialog";

const SIZE_CLASSES = {
  md: "h-[var(--input-height-md)] rounded-[var(--input-radius-md)] px-[var(--input-padding-x-md)]",
  lg: "h-[var(--input-height-lg)] rounded-[var(--input-radius-lg)] px-[var(--input-padding-x-lg)]",
  xl: "h-[var(--input-height-xl)] rounded-[var(--input-radius-xl)] px-[var(--input-padding-x-xl)]",
} as const satisfies Record<ComboboxSize, string>;

function withIconClass(node: ReactNode): ReactNode {
  if (!isValidElement<{ className?: string }>(node)) {
    return node;
  }
  return cloneElement(node, { className: cn(DEFAULT_ICON_CLASS, node.props.className) });
}

export interface ComboboxOption {
  value: string;
  label: string;
  description?: string;
  icon?: ReactNode;
  badge?: string;
  badgeVariant?: BadgeVariant;
  /** Shown but not selectable: click, Enter and only-match auto-select do nothing. */
  disabled?: boolean;
}

// On a refresh surface an option is one line, as the design's lists are: the name, then its
// detail beside it in the tertiary ink.
function ComboboxOptionContent({ option }: { option: ComboboxOption }) {
  return (
    <>
      {option.icon ? <span className="shrink-0">{option.icon}</span> : null}
      <span className="min-w-0 flex-1 refresh:flex refresh:items-baseline refresh:gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-primary">{option.label}</span>
          {option.badge ? (
            <Badge variant={option.badgeVariant} className="shrink-0">
              {option.badge}
            </Badge>
          ) : null}
        </span>
        {option.description ? (
          <span className="block truncate text-sm text-tertiary refresh:min-w-0 refresh:text-body">
            {option.description}
          </span>
        ) : null}
      </span>
    </>
  );
}

interface ComboboxProps {
  value: string | null;
  onChange: (value: string) => void;
  options: readonly ComboboxOption[];
  label: string;
  /** Visually hides the label while preserving it for the trigger's accessible name. */
  hideLabel?: boolean;
  /** Rendered after the label, e.g. an info tooltip; not part of the accessible name. */
  labelAccessory?: ReactNode;
  required?: boolean;
  className?: string;
  placeholder?: string;
  searchable?: boolean;
  searchPlaceholder?: string;
  icon?: ReactNode;
  trailing?: ReactNode;
  size?: ComboboxSize;
  variant?: ComboboxVariant;
  isLoading?: boolean;
  disabled?: boolean;
  error?: string;
  validationError?: string;
  onEnterSelect?: (value: string) => void;
  footer?: (close: () => void) => ReactNode;
  /**
   * Derives an extra option from the search text, for values that are typed or
   * pasted rather than picked (an address, a mint). Called with the trimmed
   * query; a returned option is appended to the filtered list unless an
   * existing option already carries its value. Return null for queries the
   * caller cannot turn into an option.
   */
  queryOption?: (query: string) => ComboboxOption | null;
  /**
   * What an empty list says, for a picker where an empty list is not a dead
   * end. The default reads "No options available.", which is the truth for a
   * closed list and a lie for one paired with `queryOption` — there the value
   * is typed, and the panel is the only place that can say so. Pass the
   * instruction, not a restatement of the emptiness.
   */
  emptyLabel?: string;
}

/**
 * What the panel says when nothing is listed.
 *
 * Outside the component on purpose: every branch added inline pushes `Combobox`'s complexity
 * further, and this one reads better named anyway.
 *
 * @param input - The empty-state inputs.
 * @param input.emptyLabel - Caller's wording for a list that is empty but not a dead end.
 * @param input.hasOptions - Whether the unfiltered list has anything in it.
 * @param input.t - Translator.
 * @returns The message to render.
 */
function emptyStateLabel({
  emptyLabel,
  hasOptions,
  t,
}: {
  emptyLabel: string | undefined;
  hasOptions: boolean;
  t: ReturnType<typeof useTranslations>;
}): string {
  if (hasOptions) {
    return t("Shared.SharedComponents.noSearchMatches");
  }
  return emptyLabel ?? t("Shared.SharedComponents.noOptionsAvailable");
}

/**
 * The options the search text leaves, plus the caller's typed-value option when the text makes
 * one that the list does not already carry.
 *
 * @param options - Every option.
 * @param query - The search text as typed.
 * @param searchable - Whether the list filters at all.
 * @param queryOption - Derives an option from the trimmed search text, if the caller has one.
 * @returns The options to list, in order.
 */
function filterComboboxOptions(
  options: readonly ComboboxOption[],
  query: string,
  searchable: boolean,
  queryOption: ComboboxProps["queryOption"]
): readonly ComboboxOption[] {
  const trimmed = query.trim();
  const needle = trimmed.toLowerCase();
  const base =
    !searchable || !needle
      ? options
      : options.filter((option) =>
          `${option.label} ${option.description ?? ""}`.toLowerCase().includes(needle)
        );
  if (!queryOption || !trimmed) {
    return base;
  }
  const extra = queryOption(trimmed);
  if (extra === null || base.some((option) => option.value === extra.value)) {
    return base;
  }
  return [...base, extra];
}

/**
 * The combobox's open state, search text and keyboard highlight, and the ways to pick an option.
 * Keyboard, filtering and selection stay together here so the components only draw.
 */
function useComboboxState({
  options,
  value,
  searchable,
  queryOption,
  onChange,
  onEnterSelect,
}: Pick<ComboboxProps, "options" | "value" | "queryOption" | "onChange" | "onEnterSelect"> & {
  searchable: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);

  const selected = useMemo(
    () => options.find((option) => option.value === value) ?? null,
    [options, value]
  );

  const filtered = useMemo(
    () => filterComboboxOptions(options, query, searchable, queryOption),
    [options, query, searchable, queryOption]
  );

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setQuery("");
      setActiveIndex(-1);
    }
  }

  function close() {
    setOpen(false);
    setQuery("");
    setActiveIndex(-1);
  }

  function selectOption(option: ComboboxOption, submit: boolean) {
    if (option.disabled) return;
    onChange(option.value);
    close();
    if (submit) {
      onEnterSelect?.(option.value);
    }
  }

  function selectOnlyMatch(submit = false) {
    if (filtered.length !== 1) return;
    selectOption(filtered[0], submit);
  }

  function selectActive(submit = false) {
    const active = filtered[activeIndex];
    if (!active) return false;
    selectOption(active, submit);
    return true;
  }

  /** Enter in the search: the highlighted option, else the only match. */
  function submitSearch() {
    if (!selectActive(true)) {
      selectOnlyMatch(true);
    }
  }

  useEffect(() => {
    setActiveIndex(filtered.length === 1 && !filtered[0].disabled ? 0 : -1);
  }, [filtered]);

  return {
    open,
    query,
    setQuery,
    activeIndex,
    setActiveIndex,
    selected,
    filtered,
    handleOpenChange,
    close,
    selectOption,
    submitSearch,
  };
}

/** The field's name above the trigger, with its required mark and any accessory beside it. */
function ComboboxLabel({
  labelId,
  label,
  hideLabel,
  labelAccessory,
  required,
}: {
  labelId: string;
  label: string;
  hideLabel?: boolean;
  labelAccessory?: ReactNode;
  required?: boolean;
}) {
  const t = useTranslations();
  return (
    <div className={cn("flex items-center gap-1.5", hideLabel && "sr-only")}>
      <Label id={labelId}>
        {label}
        {required ? (
          <>
            <span aria-hidden className="text-destructive">
              *
            </span>
            <span className="sr-only"> {t("Shared.SharedComponents.required")}</span>
          </>
        ) : null}
      </Label>
      {labelAccessory}
    </div>
  );
}

/** What the trigger shows: the chosen option, or the placeholder while nothing is chosen. */
function ComboboxSelection({
  selected,
  placeholder,
}: {
  selected: ComboboxOption | null;
  placeholder: string;
}) {
  return (
    <span className="min-w-0 flex-1 text-left">
      {selected ? (
        <span className="flex min-w-0 items-center gap-2">
          {selected.icon ? (
            <span className="flex shrink-0 items-center">{selected.icon}</span>
          ) : null}
          <span className="truncate text-primary">{selected.label}</span>
          {selected.badge ? (
            <Badge variant={selected.badgeVariant} className="shrink-0">
              {selected.badge}
            </Badge>
          ) : null}
          {/* An underline field shows the choice alone; the list still carries the detail. */}
          {selected.description ? (
            <span className="truncate text-sm text-tertiary refresh:hidden">
              {selected.description}
            </span>
          ) : null}
        </span>
      ) : (
        <span className="block truncate text-tertiary">{placeholder}</span>
      )}
    </span>
  );
}

interface ComboboxTriggerProps
  extends Pick<
    ComboboxProps,
    "className" | "icon" | "trailing" | "disabled" | "validationError" | "variant"
  > {
  labelId: string;
  open: boolean;
  size: ComboboxSize;
  selected: ComboboxOption | null;
  placeholder: string;
  /** Opens or closes the dialog variant; the popover variant leaves this to Radix. */
  onToggle: () => void;
}

/**
 * The field itself: a button naming the choice. In the popover variant it is the popover's
 * trigger, so Radix owns its open state and aria wiring; the dialog variant toggles on click.
 */
function ComboboxTrigger({
  labelId,
  open,
  variant,
  size,
  className,
  icon,
  trailing,
  disabled,
  validationError,
  selected,
  placeholder,
  onToggle,
}: ComboboxTriggerProps) {
  const button = (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-labelledby={labelId}
      aria-invalid={validationError ? true : undefined}
      aria-describedby={validationError ? `${labelId}-error` : undefined}
      disabled={disabled}
      onClick={variant === "dialog" ? onToggle : undefined}
      className={cn(
        "flex w-full items-center gap-2 border border-transparent bg-fill-subtle text-base transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-50",
        // Refresh surfaces draw the trigger as an underline field (radius and inset come from
        // the scope's input tokens).
        "refresh:border-x-0 refresh:border-t-0 refresh:border-b-border-default refresh:bg-transparent refresh:hover:border-b-border-strong refresh:focus-visible:border-b-primary refresh:focus-visible:ring-0",
        // Underline fields carry no leading icon; the label names the field.
        "refresh:[&>svg:first-child]:hidden",
        SIZE_CLASSES[size],
        className,
        validationError && "border-error-border hover:border-error-border"
      )}
    >
      {withIconClass(icon)}
      <ComboboxSelection selected={selected} placeholder={placeholder} />
      {trailing ? <span className="shrink-0">{trailing}</span> : null}
      <ChevronDownIcon
        className={cn(
          "size-5 shrink-0 text-tertiary transition-transform refresh:size-4 refresh:text-secondary",
          open && "rotate-180"
        )}
      />
    </button>
  );
  return variant === "dialog" ? button : <Popover.Trigger asChild>{button}</Popover.Trigger>;
}

/**
 * The search row over the list. The arrow keys move the highlight; Enter picks the highlighted
 * option, or the only match.
 */
function ComboboxSearch({
  labelId,
  variant,
  refresh,
  query,
  onQueryChange,
  activeIndex,
  setActiveIndex,
  optionCount,
  onSubmit,
  placeholder,
}: {
  labelId: string;
  variant: ComboboxVariant;
  refresh: boolean;
  query: string;
  onQueryChange: (query: string) => void;
  activeIndex: number;
  setActiveIndex: Dispatch<SetStateAction<number>>;
  optionCount: number;
  onSubmit: () => void;
  placeholder: string;
}) {
  return (
    // A refresh search row sits over the list's one divider; its field draws no underline of
    // its own, so the panel shows a single line under the search, as the design does.
    <div
      className={cn(
        "border-b border-border-default",
        variant === "dialog" ? "p-3" : "p-2",
        "refresh:border-border-subtle refresh:p-1"
      )}
    >
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-tertiary refresh:left-2.5" />
        <Input
          autoFocus
          aria-activedescendant={activeIndex >= 0 ? `${labelId}-option-${activeIndex}` : undefined}
          value={query}
          onChange={(e) => onQueryChange(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActiveIndex((current) =>
                optionCount === 0 ? -1 : Math.min(current + 1, optionCount - 1)
              );
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setActiveIndex((current) => (optionCount === 0 ? -1 : Math.max(current - 1, 0)));
              return;
            }
            if (e.key === "Enter") {
              e.preventDefault();
              onSubmit();
            }
          }}
          placeholder={placeholder}
          size={refresh ? "xl" : undefined}
          className="pl-9 refresh:pl-7.5 refresh:[&>span:first-child]:border-b-0"
          inputClassName="refresh:text-body"
        />
      </div>
    </div>
  );
}

/** One row of the list: the option, and a check when it is the current value. */
function ComboboxOptionRow({
  option,
  id,
  variant,
  active,
  highlighted,
  onHighlight,
  onSelect,
}: {
  option: ComboboxOption;
  id: string;
  variant: ComboboxVariant;
  active: boolean;
  highlighted: boolean;
  onHighlight: () => void;
  onSelect: () => void;
}) {
  return (
    <button
      id={id}
      type="button"
      disabled={option.disabled}
      aria-disabled={option.disabled || undefined}
      className={cn(
        "flex w-full items-center gap-3 rounded-[var(--select-item-radius)] text-left transition-colors",
        variant === "dialog" ? "px-3.5 py-3" : "px-3 py-2.5",
        // The design's 36px rows: 14px text, 10px in from the panel's edge.
        "refresh:min-h-9 refresh:gap-1.5 refresh:px-2.5 refresh:py-2 refresh:text-body",
        // The arrow keys may land on a disabled option, so it keeps the
        // highlight: a keyboard user must see where the cursor is.
        highlighted && "bg-[var(--select-item-highlight-bg)]",
        option.disabled
          ? "cursor-not-allowed opacity-50"
          : "hover:bg-[var(--select-item-highlight-bg)]"
      )}
      onMouseEnter={option.disabled ? undefined : onHighlight}
      onClick={onSelect}
    >
      <ComboboxOptionContent option={option} />
      {active ? <CheckIcon className="size-4 shrink-0 text-primary" /> : null}
    </button>
  );
}

/** The scrolling list: loading, error and empty states, or the filtered options. */
function ComboboxOptionList({
  labelId,
  variant,
  isLoading,
  error,
  filtered,
  value,
  activeIndex,
  emptyText,
  setActiveIndex,
  onSelect,
}: {
  labelId: string;
  variant: ComboboxVariant;
  isLoading?: boolean;
  error?: string;
  filtered: readonly ComboboxOption[];
  value: string | null;
  activeIndex: number;
  emptyText: string;
  setActiveIndex: (index: number) => void;
  onSelect: (option: ComboboxOption) => void;
}) {
  const t = useTranslations();
  return (
    <div
      className={cn(
        "overflow-y-auto",
        variant === "dialog" ? "max-h-96 p-2" : "max-h-56 p-1.5",
        "refresh:p-1"
      )}
    >
      {isLoading ? (
        <p className="px-3 py-6 text-center text-sm text-tertiary">
          {t("Shared.SharedComponents.loading")}
        </p>
      ) : error ? (
        <p className="px-3 py-6 text-center text-sm text-error">{error}</p>
      ) : filtered.length === 0 ? (
        <p className="px-3 py-6 text-center text-sm text-tertiary">{emptyText}</p>
      ) : (
        filtered.map((option, index) => (
          <ComboboxOptionRow
            key={option.value}
            id={`${labelId}-option-${index}`}
            option={option}
            variant={variant}
            active={option.value === value}
            highlighted={index === activeIndex}
            onHighlight={() => setActiveIndex(index)}
            onSelect={() => onSelect(option)}
          />
        ))
      )}
    </div>
  );
}

export function Combobox({
  value,
  onChange,
  options,
  label,
  hideLabel,
  labelAccessory,
  required,
  className,
  placeholder,
  searchable = true,
  searchPlaceholder,
  icon,
  trailing,
  size = "xl",
  variant = "popover",
  isLoading,
  disabled,
  error,
  validationError,
  onEnterSelect,
  footer,
  queryOption,
  emptyLabel,
}: ComboboxProps) {
  const t = useTranslations();
  const resolvedPlaceholder = placeholder ?? t("Shared.SharedComponents.selectAnOption");
  const resolvedSearchPlaceholder = searchPlaceholder ?? t("Shared.SharedComponents.search");
  const labelId = useId();
  const portalContainer = usePortalContainer();
  const themeScopeAttributes = useThemeScopeAttributes();
  const refresh = useThemeScope() === "refresh";
  const {
    open,
    query,
    setQuery,
    activeIndex,
    setActiveIndex,
    selected,
    filtered,
    handleOpenChange,
    close,
    selectOption,
    submitSearch,
  } = useComboboxState({ options, value, searchable, queryOption, onChange, onEnterSelect });

  const trigger = (
    <ComboboxTrigger
      labelId={labelId}
      open={open}
      variant={variant}
      size={size}
      className={className}
      icon={icon}
      trailing={trailing}
      disabled={disabled}
      validationError={validationError}
      selected={selected}
      placeholder={resolvedPlaceholder}
      onToggle={() => handleOpenChange(!open)}
    />
  );

  const panel = (
    <>
      {searchable ? (
        <ComboboxSearch
          labelId={labelId}
          variant={variant}
          refresh={refresh}
          query={query}
          onQueryChange={setQuery}
          activeIndex={activeIndex}
          setActiveIndex={setActiveIndex}
          optionCount={filtered.length}
          onSubmit={submitSearch}
          placeholder={resolvedSearchPlaceholder}
        />
      ) : null}

      <ComboboxOptionList
        labelId={labelId}
        variant={variant}
        isLoading={isLoading}
        error={error}
        filtered={filtered}
        value={value}
        activeIndex={activeIndex}
        emptyText={emptyStateLabel({ emptyLabel, hasOptions: options.length > 0, t })}
        setActiveIndex={setActiveIndex}
        onSelect={(option) => selectOption(option, false)}
      />

      {footer ? (
        <div className="border-t border-border-default refresh:border-border-subtle">
          {footer(close)}
        </div>
      ) : null}
    </>
  );

  return (
    <div className="flex flex-col gap-2">
      <ComboboxLabel
        labelId={labelId}
        label={label}
        hideLabel={hideLabel}
        labelAccessory={labelAccessory}
        required={required}
      />
      {variant === "dialog" ? (
        <>
          {trigger}
          <Modal
            isOpen={open}
            onClose={close}
            ariaLabel={label}
            size="md"
            showCloseButton={false}
            contentClassName="overflow-hidden"
          >
            {panel}
          </Modal>
        </>
      ) : (
        <Popover.Root open={open} onOpenChange={handleOpenChange}>
          {trigger}
          <Popover.Portal container={portalContainer ?? undefined}>
            {/* On a refresh surface the panel is the design's: card paper, 4px under the field, on
                a 1px ring rather than the design system's shadow (the UI stays flat). */}
            <Popover.Content
              {...themeScopeAttributes}
              sideOffset={refresh ? 4 : 8}
              align="start"
              style={{ width: "max(var(--radix-popover-trigger-width), 240px)" }}
              className="z-50 overflow-hidden rounded-[var(--select-popup-radius)] bg-[var(--select-popup-bg)] shadow-[var(--select-popup-shadow)] refresh:bg-surface-sunken refresh:shadow-none refresh:ring-1 refresh:ring-border-subtle"
            >
              {panel}
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      )}
      {validationError ? (
        <p id={`${labelId}-error`} className="text-xs text-error">
          {validationError}
        </p>
      ) : null}
    </div>
  );
}
