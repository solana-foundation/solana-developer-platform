import {
  Select as DesignSystemSelect,
  SelectItem,
  type SelectProps,
} from "@solana/design-system/select";

type UiSelectProps = SelectProps;

function Select({ className, size = "lg", ...props }: UiSelectProps) {
  return <DesignSystemSelect className={className} data-slot="select" size={size} {...props} />;
}

export { Select, SelectItem };
