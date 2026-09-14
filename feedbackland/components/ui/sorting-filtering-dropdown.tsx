"use client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";
import { FeedbackOrderBy, FeedbackStatus } from "@/lib/typings";
import { Button } from "@/components/ui/button";
import { ArrowUpDown, ChevronDown } from "lucide-react";
import { capitalizeFirstLetter, cn } from "@/lib/utils";

// 数据库枚举值的展示用中文标签（仅用于显示，不改变原值）
const STATUS_LABELS: Record<string, string> = {
  "under consideration": "考虑中",
  planned: "已列入计划",
  "in progress": "进行中",
  done: "已完成",
  declined: "已拒绝",
};

export function SortingFilteringDropdown({
  orderBy,
  status,
  onChange,
  variant = "link",
  className,
}: {
  orderBy: FeedbackOrderBy;
  status: FeedbackStatus;
  onChange: ({
    orderBy,
    status,
  }: {
    orderBy: FeedbackOrderBy;
    status: FeedbackStatus;
  }) => void;
  variant?: "link" | "outline";
  className?: string;
}) {
  const getDropdownName = () => {
    let orderByName = "最新";

    if (orderBy === "upvotes") {
      orderByName = "点赞最多";
    } else if (orderBy === "comments") {
      orderByName = "评论最多";
    }

    return (
      <>
        {orderByName}
        {status && ", "}
        {status && (
          <span className={cn(`text-${status.replace(" ", "-")}`)}>
            {STATUS_LABELS[status] ?? capitalizeFirstLetter(status)}
          </span>
        )}
      </>
    );
  };

  const handleSelectOrderBy = (value: FeedbackOrderBy) => {
    onChange({ orderBy: value, status });
  };

  const handleSelectStatus = (value: FeedbackStatus) => {
    onChange({ orderBy, status: value });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {variant === "outline" ? (
          <Button variant="outline" className={cn("gap-1.5", className)}>
            <ArrowUpDown className="size-3.5!" />
            <span className="truncate">{getDropdownName()}</span>
            <ChevronDown className="text-muted-foreground size-3.5!" />
          </Button>
        ) : (
          <Button
            variant="link"
            className="text-muted-foreground hover:text-primary h-auto p-0 hover:no-underline"
          >
            {getDropdownName()}
            <ChevronDown className="size-3.5!" />
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="flex w-full flex-row">
        <DropdownMenuRadioGroup
          value={String(orderBy)}
          onValueChange={(value) =>
            handleSelectOrderBy(value as FeedbackOrderBy)
          }
          className="border-border border-r pr-2"
        >
          <DropdownMenuRadioItem value="newest">最新</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="upvotes">
            点赞最多
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="comments">
            评论最多
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>

        <DropdownMenuRadioGroup
          value={status ? status : "all"}
          onValueChange={(value) => {
            handleSelectStatus(
              (value !== "all" ? value : null) as FeedbackStatus,
            );
          }}
          className="px-1"
        >
          <DropdownMenuRadioItem value="all">
            全部状态
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem
            value="under consideration"
            className="text-under-consideration!"
          >
            考虑中
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="planned" className="text-planned!">
            已列入计划
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem
            value="in progress"
            className="text-in-progress!"
          >
            进行中
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="done" className="text-done!">
            已完成
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="declined" className="text-declined!">
            已拒绝
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
