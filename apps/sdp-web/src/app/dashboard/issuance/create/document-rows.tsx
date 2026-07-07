"use client";

import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { DocumentRow } from "./issuance-draft-wizard.types";

interface DocumentRowsProps {
  documents: DocumentRow[];
  onChange: (documents: DocumentRow[]) => void;
  disabled?: boolean;
}

function newRow(): DocumentRow {
  return { id: crypto.randomUUID(), docType: "", name: "", url: "" };
}

export function DocumentRows({
  documents,
  onChange,
  disabled,
}: DocumentRowsProps) {
  const update = (id: string, patch: Partial<DocumentRow>) =>
    onChange(
      documents.map((doc) => (doc.id === id ? { ...doc, ...patch } : doc)),
    );
  const remove = (id: string) =>
    onChange(documents.filter((doc) => doc.id !== id));

  return (
    <div className="space-y-3">
      {documents.map((doc) => (
        <div
          key={doc.id}
          className="grid grid-cols-1 gap-2 rounded-xl border border-[rgba(28,28,29,0.1)] bg-white p-3 sm:grid-cols-[1fr_1fr_1.4fr_auto]"
        >
          <Input
            placeholder="Document type"
            disabled={disabled}
            value={doc.docType}
            onChange={(event) =>
              update(doc.id, { docType: event.currentTarget.value })
            }
          />
          <Input
            placeholder="Name"
            disabled={disabled}
            value={doc.name}
            onChange={(event) =>
              update(doc.id, { name: event.currentTarget.value })
            }
          />
          <Input
            placeholder="https://…"
            disabled={disabled}
            value={doc.url}
            onChange={(event) =>
              update(doc.id, { url: event.currentTarget.value })
            }
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={disabled}
            onClick={() => remove(doc.id)}
            aria-label="Remove document"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={disabled}
        onClick={() => onChange([...documents, newRow()])}
        iconLeft={<Plus className="h-4 w-4" />}
      >
        Add document
      </Button>
    </div>
  );
}
