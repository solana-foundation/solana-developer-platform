"use client";

import { CheckIcon, ChevronDownIcon, SearchIcon } from "lucide-react";
import { Popover } from "radix-ui";
import {
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";
import { Badge, type BadgeVariant } from "./badge";
import { cn } from "./cn";
import { useUiTranslations } from "./i18n";
import { Input } from "./input";
import { Label } from "./label";
import { Modal } from "./modal";
import { usePortalContainer } from "./portal-container";

export type ComboboxSize = "md" | "lg" | "xl";
export type ComboboxVariant = "popover" | "dialog";

const SIZE_CLASSES = {
  md: "h-[var(--input-height-md)] rounded-[var(--input-radius-md)] px-[var(--input-padding-x-md)]",
  lg: "h-[var(--input-height-lg)] rounded-[var(--input-radius-lg)] px-[var(--input-padding-x-lg)]",
  xl: "h-[var(--input-height-xl)] rounded-[var(--input-radius-xl)] px-[var(--input-padding-x-xl)]",
} as const satisfies Record<ComboboxSize, string>;

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

// An option is one line, as the design's lists are: the name, then its detail beside it in the
// tertiary ink.
function ComboboxOptionContent({ option }: { option: ComboboxOption }) {
  return (
    <>
      {option.icon ? <span className="shrink-0">{option.icon}</span> : null}
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-primary">{option.label}</span>
          {option.badge ? (
            <Badge variant={option.badgeVariant} className="shrink-0">
              {option.badge}
            </Badge>
          ) : null}
        </span>
        {option.description ? (
          <span className="block min-w-0 truncate text-body text-tertiary">
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
  t: ReturnType<typeof useUiTranslations>;
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
  const selectedLabelRepeats = useMemo(
    () =>
      selected !== null &&
      options.some((option) => option !== selected && option.label === selected.label),
    [options, selected]
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
    selectedLabelRepeats,
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
  const t = useUiTranslations();
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

/**
 * What the trigger shows: the chosen option, or the placeholder while nothing is chosen. The
 * choice shows its label alone unless another option shares that label, when its description
 * is what tells them apart.
 */
function ComboboxSelection({
  selected,
  selectedLabelRepeats,
  placeholder,
}: {
  selected: ComboboxOption | null;
  selectedLabelRepeats: boolean;
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
          {selectedLabelRepeats && selected.description ? (
            <span className="truncate text-meta text-tertiary">{selected.description}</span>
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
    "className" | "trailing" | "disabled" | "validationError" | "variant"
  > {
  labelId: string;
  open: boolean;
  size: ComboboxSize;
  selected: ComboboxOption | null;
  selectedLabelRepeats: boolean;
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
  trailing,
  disabled,
  validationError,
  selected,
  selectedLabelRepeats,
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
        // An underline field: radius and inset come from the input tokens.
        "flex w-full items-center gap-2 border border-x-0 border-t-0 border-transparent border-b-border-default bg-transparent text-base transition-colors hover:border-b-border-strong focus-visible:border-b-primary focus-visible:outline-none focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-50",
        SIZE_CLASSES[size],
        className,
        validationError && "border-error-border hover:border-error-border"
      )}
    >
      <ComboboxSelection
        selected={selected}
        selectedLabelRepeats={selectedLabelRepeats}
        placeholder={placeholder}
      />
      {trailing ? <span className="shrink-0">{trailing}</span> : null}
      <ChevronDownIcon
        className={cn("size-4 shrink-0 text-secondary transition-transform", open && "rotate-180")}
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
  query,
  onQueryChange,
  activeIndex,
  setActiveIndex,
  optionCount,
  onSubmit,
  placeholder,
}: {
  labelId: string;
  query: string;
  onQueryChange: (query: string) => void;
  activeIndex: number;
  setActiveIndex: Dispatch<SetStateAction<number>>;
  optionCount: number;
  onSubmit: () => void;
  placeholder: string;
}) {
  return (
    // The search row sits over the list's one divider; its field draws no underline of its own,
    // so the panel shows a single line under the search, as the design does.
    <div className="border-b border-border-subtle p-1">
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-tertiary" />
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
          size="xl"
          className="pl-7.5 [&>span:first-child]:border-b-0"
          inputClassName="text-body!"
        />
      </div>
    </div>
  );
}

/** One row of the list: the option, and a check when it is the current value. */
function ComboboxOptionRow({
  option,
  id,
  active,
  highlighted,
  onHighlight,
  onSelect,
}: {
  option: ComboboxOption;
  id: string;
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
        // The design's 36px rows: 14px text, 10px in from the panel's edge.
        "flex min-h-9 w-full items-center gap-1.5 rounded-[var(--select-item-radius)] px-2.5 py-2 text-left text-body transition-colors",
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
  const t = useUiTranslations();
  return (
    <div className={cn("overflow-y-auto p-1", variant === "dialog" ? "max-h-96" : "max-h-56")}>
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
  const t = useUiTranslations();
  const resolvedPlaceholder = placeholder ?? t("Shared.SharedComponents.selectAnOption");
  const resolvedSearchPlaceholder = searchPlaceholder ?? t("Shared.SharedComponents.search");
  const labelId = useId();
  const portalContainer = usePortalContainer();
  const {
    open,
    query,
    setQuery,
    activeIndex,
    setActiveIndex,
    selected,
    selectedLabelRepeats,
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
      trailing={trailing}
      disabled={disabled}
      validationError={validationError}
      selected={selected}
      selectedLabelRepeats={selectedLabelRepeats}
      placeholder={resolvedPlaceholder}
      onToggle={() => handleOpenChange(!open)}
    />
  );

  const panel = (
    <>
      {searchable ? (
        <ComboboxSearch
          labelId={labelId}
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

      {footer ? <div className="border-t border-border-subtle">{footer(close)}</div> : null}
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
            {/* The panel is the design's: card paper, 4px under the field, on a 1px ring rather
                than the design system's shadow (the UI stays flat). */}
            <Popover.Content
              sideOffset={4}
              align="start"
              style={{ width: "max(var(--radix-popover-trigger-width), 240px)" }}
              className="z-50 overflow-hidden rounded-[var(--select-popup-radius)] bg-surface-sunken shadow-none ring-1 ring-border-subtle"
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
