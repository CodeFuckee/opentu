"use client";

import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  FEEDBACK_STATUSES,
  STATUS_DOT_CLASS,
  STATUS_TEXT_CLASS,
} from "@/lib/insights";
import type { FeedbackStatus } from "@/lib/typings";

/** 数据库中的状态枚举原值，仅在展示时映射为中文。 */
const STATUS_LABELS: Record<string, string> = {
  "under consideration": "考虑中",
  planned: "已列入计划",
  "in progress": "进行中",
  done: "已完成",
  declined: "已拒绝",
};

/**
 * The insights's only action: once an insight has been dealt with, set the status
 * on all the feedback behind it at once. Same menu, same colours and same
 * wording as the per-post status menu, so there is nothing new to learn.
 */
export function InsightStatusControl({
  status,
  isMixed,
  postCount,
  onChange,
  disabled,
}: {
  status: FeedbackStatus;
  isMixed: boolean;
  postCount: number;
  onChange: (next: FeedbackStatus) => void;
  disabled?: boolean;
}) {
  const label = status
    ? STATUS_LABELS[status]
    : isMixed
      ? "混合状态"
      : "设置状态";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          aria-label={`该洞察背后 ${postCount} 条反馈的状态：${label}`}
          className="h-7 shrink-0 gap-1.5 px-2 text-xs font-normal"
        >
          <span
            aria-hidden
            className={cn(
              "size-1.5 rounded-full",
              status
                ? STATUS_DOT_CLASS[status]
                : "ring-muted-foreground/50 ring-1 ring-inset",
            )}
          />
          <span
            className={cn(
              status
                ? `capitalize ${STATUS_TEXT_CLASS[status]}`
                : "text-muted-foreground",
            )}
          >
            {label}
          </span>
          <ChevronDown className="text-muted-foreground size-3!" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
          应用于全部 {postCount} 条反馈
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={status ?? "none"}
          onValueChange={(value) =>
            onChange(value === "none" ? null : (value as FeedbackStatus))
          }
        >
          {FEEDBACK_STATUSES.map((option) => (
            <DropdownMenuRadioItem
              key={option}
              value={option}
              className={cn("capitalize", `${STATUS_TEXT_CLASS[option]}!`)}
            >
              {STATUS_LABELS[option]}
            </DropdownMenuRadioItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuRadioItem value="none">无状态</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
