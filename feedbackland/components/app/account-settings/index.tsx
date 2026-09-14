"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Username } from "./username";

export function AccountSettings({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-[420px]!">
        <DialogHeader>
          <DialogTitle className="h3 mb-5 text-center">
            账户设置
          </DialogTitle>
        </DialogHeader>
        <Username onSaved={onClose} />
      </DialogContent>
    </Dialog>
  );
}
