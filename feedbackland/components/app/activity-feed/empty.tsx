"use client";

import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Button } from "@/components/ui/button";
import { CheckCheck, Inbox, ListFilter, SearchX } from "lucide-react";

export type ActivityEmptyVariant =
  | "platform"
  | "caught-up"
  | "search"
  | "filter";

export function ActivityFeedEmpty({
  variant,
  onReset,
}: {
  variant: ActivityEmptyVariant;
  onReset?: () => void;
}) {
  const config = {
    platform: {
      icon: <Inbox />,
      title: "暂无动态",
      description: "用户提交的反馈和评论会实时显示在这里。",
      actionLabel: null as string | null,
    },
    "caught-up": {
      icon: <CheckCheck />,
      title: "已全部看完",
      description: "现在没有需要查看的新内容。",
      actionLabel: "显示全部动态",
    },
    search: {
      icon: <SearchX />,
      title: "没有找到匹配项",
      description: "没有与你的搜索匹配的动态。",
      actionLabel: "清除搜索",
    },
    filter: {
      icon: <ListFilter />,
      title: "这里没有内容",
      description: "没有符合当前筛选条件的动态。",
      actionLabel: "重置筛选",
    },
  }[variant];

  return (
    <Empty className="border-0 py-16">
      <EmptyHeader>
        <EmptyMedia variant="icon">{config.icon}</EmptyMedia>
        <EmptyTitle>{config.title}</EmptyTitle>
        <EmptyDescription>{config.description}</EmptyDescription>
      </EmptyHeader>
      {config.actionLabel && onReset && (
        <EmptyContent>
          <Button variant="outline" size="sm" onClick={onReset}>
            {config.actionLabel}
          </Button>
        </EmptyContent>
      )}
    </Empty>
  );
}
