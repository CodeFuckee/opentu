"use client";

import { useFeedbackPosts } from "@/hooks/use-feedback-posts";
import { FeedbackPostCompact } from "@/components/app/feedback-post/compact";
import { Spinner } from "@/components/ui/spinner";
import { FeedbackPostsSearchInput } from "./search-input";
import { useInView } from "react-intersection-observer";
import { FeedbackPostsLoading } from "./loading";
import { SortingFilteringDropdown } from "@/components/ui/sorting-filtering-dropdown";
import { feedbackPostsStateAtom, previousPathnameAtom } from "@/lib/atoms";
import { useAtom, useAtomValue } from "jotai";
import { useIsDrawerEmbed } from "@/providers/embed";
import { useIsDesktop } from "@/hooks/use-is-desktop";
import { cn, isUuidV4 } from "@/lib/utils";
import { useEffect, useState } from "react";
import { FeedbackPostsEmpty } from "./empty";
import { Separator } from "@/components/ui/separator";

// 数据库枚举值的展示用中文标签（仅用于显示，不改变原值）
const STATUS_LABELS: Record<string, string> = {
  "under consideration": "考虑中",
  planned: "已列入计划",
  "in progress": "进行中",
  done: "已完成",
  declined: "已拒绝",
};

function isInViewport(el: Element) {
  if (!(el instanceof HTMLElement)) return false;

  const rect = el.getBoundingClientRect();

  return (
    rect.bottom >= 0 &&
    rect.right >= 0 &&
    rect.top <= (window.innerHeight || document.documentElement.clientHeight) &&
    rect.left <= (window.innerWidth || document.documentElement.clientWidth)
  );
}

export function FeedbackPosts() {
  const isDesktop = useIsDesktop();
  const [isScrolledIntoView, setIsScrolledIntoView] = useState(false);
  const [feedbackPostsState, setFeedbackPostsState] = useAtom(
    feedbackPostsStateAtom,
  );
  const isDrawerEmbed = useIsDrawerEmbed();
  const previousPathname = useAtomValue(previousPathnameAtom);
  const previousPathnameLastSegment = previousPathname?.split("/").pop();
  const postIdToScrollIntoView = isUuidV4(previousPathnameLastSegment || "")
    ? previousPathnameLastSegment
    : null;

  const { searchValue, orderBy, status } = feedbackPostsState;

  const isSearchActive = !!(searchValue?.length > 0);

  const {
    query: {
      data,
      fetchNextPage,
      hasNextPage,
      isFetchingNextPage,
      isPending,
      isError,
    },
  } = useFeedbackPosts({
    enabled: true,
    orderBy,
    status,
    searchValue,
  });

  const posts = data?.pages.flatMap((page) => page.feedbackPosts) || [];

  const isPlatformEmpty =
    !isPending &&
    !isSearchActive &&
    !isError &&
    status === null &&
    Array.isArray(posts) &&
    posts?.length === 0;

  const isSearchEmpty =
    !isPending &&
    isSearchActive &&
    !isError &&
    Array.isArray(posts) &&
    posts?.length === 0;

  const { ref } = useInView({
    onChange: (inView) => {
      if (inView && hasNextPage && !isFetchingNextPage) {
        fetchNextPage();
      }
    },
  });

  useEffect(() => {
    if (
      isDrawerEmbed &&
      postIdToScrollIntoView &&
      !isScrolledIntoView &&
      !isPending
    ) {
      setIsScrolledIntoView(true);

      const element = document.querySelector(
        `[data-post-id="${postIdToScrollIntoView}"]`,
      );

      if (element) {
        setTimeout(() => {
          if (!isInViewport(element)) {
            element.scrollIntoView({ behavior: "instant", block: "center" });
          }
        }, 20);
      }
    }
  }, [isDrawerEmbed, postIdToScrollIntoView, isScrolledIntoView, isPending]);

  const hasPosts =
    !isPending && !isError && Array.isArray(posts) && posts.length > 0;

  const hasNoPosts =
    !isPending &&
    !isError &&
    !isPlatformEmpty &&
    !isSearchEmpty &&
    status !== null &&
    Array.isArray(posts) &&
    posts.length === 0;

  return (
    <div className="">
      {!!((!isPending && !isPlatformEmpty) || isSearchActive) &&
        !isDesktop && (
          <div className="relative mb-1.5 flex h-[40px] items-center justify-between gap-4">
            <SortingFilteringDropdown
              orderBy={orderBy}
              status={status}
              onChange={({ orderBy, status }) => {
                setFeedbackPostsState((prev) => ({
                  ...prev,
                  orderBy,
                  status,
                }));
              }}
            />

            <FeedbackPostsSearchInput />
          </div>
        )}

      {isPending && <FeedbackPostsLoading />}

      {isError && (
        <div className="text-destructive py-4 text-center">
          加载反馈失败
        </div>
      )}

      {isPlatformEmpty && <FeedbackPostsEmpty />}

      {isSearchEmpty && (
        <div className="text-muted-foreground py-5 text-center text-sm font-normal">
          没有符合搜索条件的反馈
        </div>
      )}

      {hasNoPosts && (
        <div className="text-muted-foreground py-5 text-center text-sm font-normal">
          没有找到{status ? (STATUS_LABELS[status] ?? status) : status}的反馈
        </div>
      )}

      {hasPosts && (
        <div className="border-border bg-background rounded-lg border shadow-xs">
          {posts.map((post, index) => (
            <FeedbackPostCompact
              key={post.id}
              postId={post.id}
              authorId={post.authorId}
              title={post.title}
              description={post.description}
              status={post.status}
              createdAt={post.createdAt}
              category={post.category}
              upvoteCount={post.upvotes}
              commentCount={String(post?.commentCount)}
              hasUserUpvote={post.hasUserUpvote}
              className={cn("", {
                "border-b-0": index === posts.length - 1,
              })}
            />
          ))}

          {isFetchingNextPage && (
            <div className="border-border flex items-center justify-start border-t p-5">
              <Spinner />
              <span className="ml-2 text-sm">
                正在加载更多反馈…
              </span>
            </div>
          )}

          <div ref={ref} className="h-1 w-full" />
        </div>
      )}
    </div>
  );
}
