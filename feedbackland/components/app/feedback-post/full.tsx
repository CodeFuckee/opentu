"use client";

import { timeAgo } from "@/lib/time-ago";
import { UpvoteButton } from "@/components/app/upvote-button";
import { CommentsButton } from "@/components/app/comments-button.tsx";
import { cn } from "@/lib/utils";
import { useFeedbackPost } from "@/hooks/use-feedback-post";
import { GoBackButton } from "./go-back-button";
import { useEffect, useState } from "react";
import { FeedbackPostOptionsMenu } from "./options-menu";
import { FeedbackPostEdit } from "./edit";
import { TiptapOutput } from "@/components/ui/tiptap-output";
import { useIsDesktop } from "@/hooks/use-is-desktop";
import { useIsDrawerEmbed } from "@/providers/embed";
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

export function FeedbackPostFull({
  postId,
  className,
  onLoaded,
}: {
  postId: string;
  className?: React.ComponentProps<"div">["className"];
  onLoaded?: () => void;
}) {
  const isDesktop = useIsDesktop();
  // The in-post back arrow is only shown inside the drawer widget, where it is
  // the sole way back to the feedback list; the full platform relies on its own
  // header navigation instead.
  const isDrawerEmbed = useIsDrawerEmbed();

  const [isEditing, setIsEditing] = useState(false);

  const {
    query: { data, isPending },
  } = useFeedbackPost({ postId });

  useEffect(() => {
    if (data) {
      onLoaded?.();
    }
  }, [data, onLoaded]);

  if (isPending) {
    return (
      <div className={cn("flex flex-col items-stretch space-y-3", className)}>
        <div className="flex flex-col items-stretch gap-2">
          {isDrawerEmbed && <Skeleton className="size-5 rounded-md" />}
          <div className="flex flex-col items-stretch gap-0.5">
            <Skeleton className="h-7 w-3/5" />
            {!isDesktop && (
              <div className="mt-1 flex items-center gap-1.5">
                <Skeleton className="h-3 w-28" />
                <Skeleton className="h-3 w-10" />
                <Skeleton className="h-4 w-14 rounded-full" />
              </div>
            )}
          </div>
        </div>
        <div className="space-y-2.5 py-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-4 w-3/5" />
        </div>
        <div className="flex items-center gap-2 pt-1">
          <Skeleton className="h-[25px] w-16 rounded-md" />
          <Skeleton className="h-[25px] w-16 rounded-md" />
        </div>
      </div>
    );
  }

  if (data) {
    const {
      title,
      description,
      createdAt,
      category,
      upvotes,
      hasUserUpvote,
      authorName,
      commentCount,
      status,
    } = data;

    return (
      <div>
        {isEditing ? (
          <FeedbackPostEdit
            postId={postId}
            title={title}
            description={description}
            onClose={() => setIsEditing(false)}
          />
        ) : (
          <div
            className={cn("flex flex-col items-stretch space-y-3", className)}
          >
            <div className="flex flex-col items-stretch gap-2">
              {isDrawerEmbed && <GoBackButton />}
              <div className="flex flex-col items-stretch gap-0.5">
                <div className="flex items-center justify-between gap-3.5">
                  <h1 className="text-xl font-semibold tracking-tight">
                    {title}
                  </h1>
                  <FeedbackPostOptionsMenu
                    postId={postId}
                    authorId={data.authorId}
                    onEdit={() => setIsEditing(true)}
                  />
                </div>
                {!isDesktop && (
                  <div className="text-muted-foreground flex flex-wrap items-center gap-1 text-xs font-normal">
                    <span>
                      由 {authorName || "匿名用户"} 发布
                    </span>
                    <span className="text-muted-foreground/50">·</span>
                    <span>{timeAgo.format(createdAt, "mini-now")}</span>
                    <span className="text-muted-foreground/50">·</span>
                    <Badge
                      variant="secondary"
                      className="px-1.5 py-0 text-xs capitalize"
                    >
                      {category ? (CATEGORY_LABELS[category] ?? category) : category}
                    </Badge>
                    {status && (
                      <>
                        <span className="text-muted-foreground/50">·</span>
                        <Badge
                          variant="secondary"
                          className={cn(
                            "px-1.5 py-0 text-xs capitalize",
                            `text-${status.replace(" ", "-")}`,
                          )}
                        >
                          {STATUS_LABELS[status] ?? status}
                        </Badge>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>

            <TiptapOutput content={description} />

            <div className="flex items-center gap-2 pt-1">
              <UpvoteButton
                postId={postId}
                upvoteCount={upvotes}
                hasUserUpvote={hasUserUpvote}
              />
              <CommentsButton commentCount={commentCount?.toString() || "0"} />
            </div>
          </div>
        )}
      </div>
    );
  }
}
