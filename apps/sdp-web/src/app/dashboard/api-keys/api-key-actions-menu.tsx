"use client";

import { ChevronDown } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { rotateApiKeyAction } from "./actions";
import { DeleteApiKeyModal } from "./delete-api-key-modal";

const DEFAULT_ROTATION_GRACE_HOURS = 24;

interface ApiKeyActionsMenuProps {
  keyId: string;
  keyName: string;
  canRotate: boolean;
  onDeleted?: () => void;
}

export function ApiKeyActionsMenu({
  keyId,
  keyName,
  canRotate,
  onDeleted,
}: ApiKeyActionsMenuProps) {
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const rotateFormRef = useRef<HTMLFormElement | null>(null);

  return (
    <>
      <form ref={rotateFormRef} action={rotateApiKeyAction} className="hidden">
        <input type="hidden" name="keyId" value={keyId} />
        <input type="hidden" name="grace" value={String(DEFAULT_ROTATION_GRACE_HOURS)} />
      </form>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="rounded-full px-5 whitespace-nowrap"
            iconRight={<ChevronDown className="size-4" />}
          >
            Actions
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[200px]">
          <DropdownMenuItem
            onSelect={() => {
              if (canRotate) {
                rotateFormRef.current?.requestSubmit();
              }
            }}
            disabled={!canRotate}
          >
            Rotate key ({DEFAULT_ROTATION_GRACE_HOURS}h grace)
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-[#c71f37] focus:bg-[#c71f37]/10 focus:text-[#c71f37]"
            onSelect={() => setIsDeleteModalOpen(true)}
          >
            Delete key
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DeleteApiKeyModal
        keyId={keyId}
        keyName={keyName}
        open={isDeleteModalOpen}
        onOpenChange={setIsDeleteModalOpen}
        onDeleted={onDeleted}
        renderTrigger={() => null}
      />
    </>
  );
}
