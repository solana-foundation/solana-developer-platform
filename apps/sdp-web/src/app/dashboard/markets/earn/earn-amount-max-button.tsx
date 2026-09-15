interface EarnAmountMaxButtonProps {
  disabled: boolean;
  label: string;
  onClick: () => void;
}

export function EarnAmountMaxButton({ disabled, label, onClick }: EarnAmountMaxButtonProps) {
  return (
    <button
      className="pointer-events-auto shrink-0 rounded-md bg-fill-strong px-2 py-1 text-xs font-semibold text-secondary transition-[background-color,color] duration-150 hover:bg-border-strong hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-default disabled:pointer-events-none disabled:bg-fill-subtle disabled:text-tertiary"
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  );
}
