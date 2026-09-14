"use client";

import { useState } from "react";
import { MoreHorizontal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { usePlatformUrl } from "@/hooks/use-platform-url";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import { FeedbackStatus } from "@/lib/typings";
import { useFeedbackPost } from "@/hooks/use-feedback-post";
import { useUpdateStatus } from "@/hooks/use-update-status";
import { cn } from "@/lib/utils";
import { isUuidV4 } from "@/lib/utils";
import { useDeleteFeedbackPost } from "@/hooks/use-delete-feedback-post";

export function FeedbackPostOptionsMenu({
  postId,
  authorId,
  variant = "link",
  onEdit,
  className,
}: {
  postId: string;
  authorId?: string | null;
  variant?: "ghost" | "link" | "default" | "secondary";
  onEdit?: () => void;
  className?: React.ComponentProps<"div">["className"];
}) {
  const pathname = usePathname();

  const lastUrlSegment = pathname?.split("/")?.pop() || "";
  const isFeedbackPage = isUuidV4(lastUrlSegment);

  const updateStatus = useUpdateStatus({ postId });

  const platformUrl = usePlatformUrl();
  const router = useRouter();
  const { session, isAdmin } = useAuth();

  const {
    query: { data },
  } = useFeedbackPost({
    postId,
    enabled: true,
  });

  const deletePost = useDeleteFeedbackPost();

  const [isDeleteConfirmationOpen, setIsDeleteConfirmationOpen] =
    useState(false);

  const handleDelete = async () => {
    deletePost.mutate(
      {
        postId,
      },
      {
        onSuccess: () => {
          toast.success("反馈已删除", {
            position: "top-right",
          });

          if (platformUrl && isFeedbackPage) {
            router.push(platformUrl);
          }
        },
        onSettled: () => {
          setIsDeleteConfirmationOpen(false);
        },
      },
    );
  };

  const isAuthor = session?.user?.id === authorId;
  const isVisible = !!(isAuthor || isAdmin);
  const status = data?.status;

  if (isVisible) {
    return (
      <>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant={variant}
              size="icon"
              aria-label="打开选项菜单"
              className={cn(
                "text-muted-foreground hover:text-primary h-fit w-fit px-1.5 py-1.5 hover:no-underline",
                className,
              )}
            >
              <MoreHorizontal className="size-4" />
              <span className="sr-only">选项</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuGroup>
              {onEdit !== undefined && (
                <DropdownMenuItem onClick={() => onEdit?.()}>
                  编辑反馈
                </DropdownMenuItem>
              )}
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>设置状态</DropdownMenuSubTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuSubContent className="w-48">
                    <DropdownMenuRadioGroup
                      value={status ?? "none"}
                      onValueChange={(value) =>
                        updateStatus.mutate({
                          postId,
                          status:
                            value === "none"
                              ? null
                              : (value as FeedbackStatus),
                        })
                      }
                    >
                      <DropdownMenuRadioItem value="none">
                        无状态
                      </DropdownMenuRadioItem>
                      <DropdownMenuRadioItem
                        value="under consideration"
                        className="text-under-consideration!"
                      >
                        考虑中
                      </DropdownMenuRadioItem>
                      <DropdownMenuRadioItem
                        value="planned"
                        className="text-planned!"
                      >
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
                      <DropdownMenuRadioItem
                        value="declined"
                        className="text-declined!"
                      >
                        已拒绝
                      </DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                  </DropdownMenuSubContent>
                </DropdownMenuPortal>
              </DropdownMenuSub>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem
                onClick={() => setIsDeleteConfirmationOpen(true)}
                className="text-destructive focus:text-destructive focus:bg-destructive/10"
              >
                删除反馈
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <AlertDialog open={isDeleteConfirmationOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                确定要删除这条反馈吗？
              </AlertDialogTitle>
              <AlertDialogDescription>
                此操作无法撤销，该反馈将被永久删除。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel
                onClick={() => setIsDeleteConfirmationOpen(false)}
                disabled={deletePost.isPending}
              >
                取消
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={handleDelete}
                disabled={deletePost.isPending}
                className={buttonVariants({ variant: "destructive" })}
              >
                删除
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </>
    );
  }

  return null;
}
