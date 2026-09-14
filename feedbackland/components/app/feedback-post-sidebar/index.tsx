"use client";

import { capitalizeFirstLetter, cn } from "@/lib/utils";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useFeedbackPost } from "@/hooks/use-feedback-post";
import { Label } from "@/components/ui/label";
import { UserIcon } from "lucide-react";
import { format } from "date-fns";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";

import { Skeleton } from "@/components/ui/skeleton";

// 数据库枚举值的展示用中文标签（仅用于显示，不改变原值）
const STATUS_LABELS: Record<string, string> = {
  "under consideration": "考虑中",
  planned: "已列入计划",
  "in progress": "进行中",
  done: "已完成",
  declined: "已拒绝",
};

const CATEGORY_LABELS: Record<string, string> = {
  issue: "问题",
  idea: "建议",
  "general feedback": "一般反馈",
};

const statusLabel = (status: string | null) =>
  (status && STATUS_LABELS[status]) || capitalizeFirstLetter(status || "");

const categoryLabel = (category: string | null) =>
  (category && CATEGORY_LABELS[category]) || capitalizeFirstLetter(category || "");

export default function FeedbackPostSidebar({
  postId,
  className,
}: {
  postId: string;
  className?: React.ComponentProps<"div">["className"];
}) {
  const {
    query: { data, isPending },
  } = useFeedbackPost({ postId });

  if (isPending) {
    return (
      <div
        className={cn(
          "border-border bg-background sticky top-7 mt-1 flex w-[280px] shrink-0 flex-col items-stretch rounded-lg border p-5 shadow-sm",
          className,
        )}
      >
        <div className="flex items-center gap-2.5">
          <Skeleton className="size-8 rounded-full" />
          <div className="flex flex-col gap-1">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-3 w-10" />
          </div>
        </div>
        <Separator className="my-4" />
        <div className="space-y-3.5">
          <div className="flex items-center justify-between">
            <Skeleton className="h-3 w-14" />
            <Skeleton className="h-3 w-20" />
          </div>
          <div className="flex items-center justify-between">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-5 w-16 rounded-full" />
          </div>
          <div className="flex items-center justify-between">
            <Skeleton className="h-3 w-12" />
            <Skeleton className="h-5 w-20 rounded-full" />
          </div>
        </div>
      </div>
    );
  }

  if (data) {
    const { category, authorName, authorPhotoURL, status, createdAt } = data;

    return (
      <div
        className={cn(
          "border-border bg-background sticky top-7 mt-1 flex w-[280px] shrink-0 flex-col items-stretch rounded-lg border p-5 shadow-sm",
          className,
        )}
      >
        <div className="flex items-center gap-2.5">
          <Avatar className="size-8">
            <AvatarImage
              src={authorPhotoURL || undefined}
              alt="用户头像"
            />
            <AvatarFallback>
              {authorName?.charAt(0) || <UserIcon className="size-4" />}
            </AvatarFallback>
          </Avatar>
          <div className="flex flex-col">
            <span className="text-sm font-medium">{authorName || "匿名用户"}</span>
            <span className="text-muted-foreground text-xs">发布者</span>
          </div>
        </div>
        <Separator className="my-4" />
        <div className="space-y-3.5">
          {createdAt && (
            <div className="flex items-center justify-between">
              <Label className="text-muted-foreground text-xs">发布于</Label>
              <span className="text-xs">{format(createdAt, "yyyy年M月d日")}</span>
            </div>
          )}
          {category && (
            <div className="flex items-center justify-between">
              <Label className="text-muted-foreground text-xs">分类</Label>
              <Badge variant="secondary" className="capitalize text-xs">
                {categoryLabel(category)}
              </Badge>
            </div>
          )}
          {status && (
            <div className="flex items-center justify-between">
              <Label className="text-muted-foreground text-xs">状态</Label>
              <Badge
                variant="secondary"
                className={cn("capitalize text-xs", `text-${status?.replace(" ", "-")}`)}
              >
                {statusLabel(status)}
              </Badge>
            </div>
          )}
        </div>
      </div>
    );
  }
}
