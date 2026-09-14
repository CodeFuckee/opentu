"use client";

import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { TextSelect } from "lucide-react";

export function FeedbackPostsEmpty() {
  return (
    <Empty className="md:border-2 md:border-dashed md:py-[127px]!">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <TextSelect />
        </EmptyMedia>
        <EmptyTitle>还没有反馈</EmptyTitle>
        <EmptyDescription>
          快来分享你的第一个想法吧！
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
