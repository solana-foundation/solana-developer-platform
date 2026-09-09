import {
  ArrowLeftRightIcon,
  ChartNoAxesCombinedIcon,
  ChevronDownIcon,
  CircleHelpIcon,
  CreditCardIcon,
  LayoutDashboardIcon,
  SettingsIcon,
} from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

const navigation = [
  { label: "Overview", icon: LayoutDashboardIcon, active: true },
  { label: "Accounts", icon: CreditCardIcon },
  { label: "Move money", icon: ArrowLeftRightIcon },
  { label: "Yield", icon: ChartNoAxesCombinedIcon },
];

export function BankSidebar() {
  return (
    <aside className="hidden w-64 shrink-0 flex-col justify-between px-5 py-6 lg:flex">
      <div className="flex flex-col gap-8">
        <div className="flex items-center gap-3 px-2">
          <NorthstarMark />
          <span className="text-[17px] font-semibold tracking-[-0.02em]">
            Northstar
          </span>
        </div>

        <nav className="flex flex-col gap-1" aria-label="Bank navigation">
          {navigation.map(({ label, icon: Icon, active }) => (
            <Button
              key={label}
              type="button"
              variant={active ? "secondary" : "ghost"}
              className="h-10 justify-start px-3 text-sm"
              aria-current={active ? "page" : undefined}
            >
              <Icon data-icon="inline-start" />
              {label}
            </Button>
          ))}
        </nav>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <Button
            type="button"
            variant="ghost"
            className="h-10 justify-start px-3 text-sm"
          >
            <CircleHelpIcon data-icon="inline-start" />
            Help center
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="h-10 justify-start px-3 text-sm"
          >
            <SettingsIcon data-icon="inline-start" />
            Settings
          </Button>
        </div>
        <Separator />
        <Button
          type="button"
          variant="ghost"
          className="h-auto justify-start px-2 py-2"
        >
          <Avatar className="size-8">
            <AvatarFallback>AK</AvatarFallback>
          </Avatar>
          <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
            <span className="truncate text-sm font-medium">Alex Kim</span>
            <span className="truncate text-xs text-muted-foreground">
              Personal
            </span>
          </span>
          <ChevronDownIcon data-icon="inline-end" />
        </Button>
      </div>
    </aside>
  );
}

export function MobileHeader() {
  return (
    <header className="flex items-center justify-between border-b bg-card px-4 py-3 lg:hidden">
      <div className="flex items-center gap-2.5">
        <NorthstarMark compact />
        <span className="font-semibold tracking-[-0.02em]">Northstar</span>
      </div>
      <Avatar className="size-8">
        <AvatarFallback>AK</AvatarFallback>
      </Avatar>
    </header>
  );
}

function NorthstarMark({ compact = false }: { compact?: boolean }) {
  return (
    <span
      className={compact ? "brand-mark size-8" : "brand-mark size-9"}
      aria-label="Northstar Bank"
      role="img"
    >
      <span />
    </span>
  );
}
