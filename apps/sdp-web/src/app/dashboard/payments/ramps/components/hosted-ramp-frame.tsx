"use client";

import { Maximize2Icon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";

const FRAME_ALLOW =
  "accelerometer; autoplay; camera; encrypted-media; fullscreen; geolocation; gyroscope; payment";

export function HostedRampFrame({ title, src }: { title: string; src: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div>
      <div className="relative overflow-hidden rounded-2xl">
        <iframe title={title} src={src} className="h-[480px] w-full border-0" allow={FRAME_ALLOW} />
        <div className="absolute top-3 right-3 z-10">
          <Button
            type="button"
            variant="secondary"
            size="xs"
            iconLeft={<Maximize2Icon />}
            onClick={() => setExpanded(true)}
            className="shadow-sm"
          >
            Open full screen
          </Button>
        </div>
      </div>
      <Modal
        isOpen={expanded}
        ariaLabel={title}
        onClose={() => setExpanded(false)}
        size="xl"
        contentClassName="max-w-5xl"
      >
        <div className="overflow-hidden rounded-2xl px-1 pt-12 pb-1">
          <iframe
            title={title}
            src={src}
            className="h-[80vh] w-full border-0"
            allow={FRAME_ALLOW}
          />
        </div>
      </Modal>
    </div>
  );
}
