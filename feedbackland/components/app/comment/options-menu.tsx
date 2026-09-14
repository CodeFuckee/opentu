"use client";

import { useState } from "react";
import { MoreHorizontal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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
import { useTRPC } from "@/providers/trpc-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { toast } from "sonner";

export function CommentsOptionsMenu({
  postId,
  commentId,
  authorId,
  variant = "link",
  onEdit,
}: {
  postId: string;
  commentId: string;
  authorId?: string;
  variant?: "ghost" | "link" | "default" | "secondary";
  onEdit?: () => void;
}) {
  const { session, isAdmin } = useAuth();
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const [isDeleteConfirmationOpen, setIsDeleteConfirmationOpen] =
    useState(false);

  const deleteComment = useMutation(
    trpc.deleteComment.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: trpc.getComments.queryKey().slice(0, 1),
        });

        queryClient.invalidateQueries({
          queryKey: trpc.getFeedbackPosts.queryKey().slice(0, 1),
        });

        queryClient.invalidateQueries({
          queryKey: trpc.getFeedbackPost.queryKey({ postId }),
        });

        queryClient.invalidateQueries({
          queryKey: trpc.getActivityFeed.queryKey().slice(0, 1),
        });

        queryClient.invalidateQueries({
          queryKey: trpc.getActivityFeedMetaData.queryKey(),
        });

        toast.success("评论已删除", {
          position: "top-right",
        });
      },
      onSettled: () => {
        setIsDeleteConfirmationOpen(false);
      },
    }),
  );

  const handleDelete = async () => {
    deleteComment.mutate({
      commentId,
    });
  };

  const isAuthor = session?.user?.id === authorId;
  const isVisible = !!(isAuthor || isAdmin);

  if (isVisible) {
    return (
      <>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant={variant}
              size="icon"
              aria-label="打开选项菜单"
              className="text-muted-foreground hover:text-primary h-fit w-fit px-1.5 py-1.5 hover:no-underline"
            >
              <MoreHorizontal className="size-4" />
              <span className="sr-only">选项</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {onEdit !== undefined && (
              <>
                <DropdownMenuItem onClick={() => onEdit?.()}>
                  编辑评论
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem
              onClick={() => setIsDeleteConfirmationOpen(true)}
              className="text-destructive focus:text-destructive focus:bg-destructive/10"
            >
              删除评论
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <AlertDialog open={isDeleteConfirmationOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                确定要删除这条评论吗？
              </AlertDialogTitle>
              <AlertDialogDescription>
                此操作无法撤销，评论将被永久删除。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel
                onClick={() => setIsDeleteConfirmationOpen(false)}
                disabled={deleteComment.isPending}
              >
                取消
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={handleDelete}
                disabled={deleteComment.isPending}
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
