"use client";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Layers, MessageSquarePlus, SearchX, Sparkles } from "lucide-react";

/** Nothing on the board to analyse yet. */
export function InsightsNoFeedback() {
  return (
    <Empty className="py-16">
      <EmptyHeader className="max-w-md">
        <EmptyMedia variant="icon">
          <MessageSquarePlus />
        </EmptyMedia>
        <EmptyTitle>还没有可分析的反馈</EmptyTitle>
        <EmptyDescription>
          一旦有人发布反馈，他们的意见就会被归集到这里，凝聚成少数值得行动的主题。
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

/**
 * Feedback exists; the insights have never been generated.
 *
 * The one screen guaranteed to be read before anything is generated, so it is
 * where the page explains itself in full: what goes in, what comes out, and what
 * decides the order. The icon says the same thing — separate posts stacked into
 * one — which is more use here than a sparkle.
 */
export function InsightsFirstRun({
  onGenerate,
  isGenerating,
  postCount,
}: {
  onGenerate: () => void;
  isGenerating: boolean;
  postCount: number;
}) {
  return (
    <Empty className="py-16">
      <EmptyHeader className="max-w-md">
        <EmptyMedia variant="icon">
          <Layers />
        </EmptyMedia>
        <EmptyTitle>看看你的反馈汇聚成了什么</EmptyTitle>
        <EmptyDescription>
          将读取全部 {postCount} 条公开反馈，把诉求相同的归为一组，再按每个主题的支持人数、增长速度以及问题的严重程度进行排序。
        </EmptyDescription>
      </EmptyHeader>

      <EmptyContent>
        <Button size="lg" onClick={onGenerate} loading={isGenerating}>
          <Sparkles className="size-4" />
          生成洞察
        </Button>
      </EmptyContent>
    </Empty>
  );
}

/** Search matched nothing. */
export function InsightsNoMatches({ onClear }: { onClear: () => void }) {
  return (
    <Empty className="py-14">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SearchX />
        </EmptyMedia>
        <EmptyTitle>没有与你搜索匹配的洞察</EmptyTitle>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="outline" size="sm" onClick={onClear}>
          清除搜索
        </Button>
      </EmptyContent>
    </Empty>
  );
}
