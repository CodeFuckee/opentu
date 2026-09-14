"use client";

import { ArrowRight, Info } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { timeAgo } from "@/lib/time-ago";
import type { InsightsRun } from "@/lib/typings";

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-xs">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="text-right tabular-nums">{value}</span>
    </div>
  );
}

function Dot() {
  return (
    <span aria-hidden className="text-[8px]">
      &middot;
    </span>
  );
}

/**
 * The head of the list, and the page's whole job in one line: this many posts
 * became this many insights.
 *
 * It sits on the list rather than under the page title because that is what it
 * describes — these rows are the output of that transformation, and attaching
 * the arithmetic to them is what makes the grouping legible instead of
 * something you have to take on trust. The two counts carry the weight; how
 * many are new and how many fit no grouping are footnotes to them, set smaller.
 * The rest of the run — what was left out, what dropped off, which model read
 * it — is one click away, because an analysis that hides how much it read asks
 * to be believed rather than checked.
 */
export function InsightsRunStrip({ run }: { run: InsightsRun }) {
  const ungrouped = Math.max(0, run.postsAnalyzed - run.postsClustered);
  const skipped = Math.max(0, run.postsTotal - run.postsAnalyzed);
  const hasFootnotes = run.newInsightCount > 0 || ungrouped > 0;

  return (
    <div className="border-border bg-muted/40 flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-b px-4 py-2.5 sm:px-5">
      <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span className="flex items-center gap-2 whitespace-nowrap">
          <span className="tabular-nums">
            <span className="font-medium">{run.postsAnalyzed}</span> 条反馈
          </span>
          <ArrowRight
            aria-hidden
            className="text-muted-foreground/70 size-3.5 shrink-0"
          />
          <span className="tabular-nums">
            <span className="font-medium">{run.insightCount}</span> 条洞察
          </span>
        </span>

        {hasFootnotes && (
          <span className="text-muted-foreground flex items-center gap-1.5 text-xs whitespace-nowrap">
            <Dot />
            {run.newInsightCount > 0 && (
              <span className="tabular-nums">{run.newInsightCount} 条新增</span>
            )}
            {run.newInsightCount > 0 && ungrouped > 0 && <Dot />}
            {ungrouped > 0 && (
              <span className="tabular-nums">{ungrouped} 条未分组</span>
            )}
          </span>
        )}
      </p>

      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="text-muted-foreground hover:bg-background hover:text-foreground focus-visible:ring-ring -my-0.5 ml-auto flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:outline-none"
          >
            {timeAgo.format(run.createdAt, "round")}
            <Info aria-hidden className="size-3.5" />
            <span className="sr-only">查看本次分析的详情</span>
          </button>
        </PopoverTrigger>

        <PopoverContent align="end" className="w-80 space-y-2.5">
          <div className="text-sm font-semibold">上次分析</div>

          <div className="space-y-1.5">
            <Line
              label="分析时间"
              value={new Date(run.createdAt).toLocaleString(undefined, {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            />
            <Line
              label="已读取反馈"
              value={`${run.postsAnalyzed} / ${run.postsTotal}`}
            />
            <Line label="发现洞察" value={`${run.insightCount}`} />
            <Line label="未明确分组" value={`${ungrouped} 条`} />
            <Line label="本次新增" value={`${run.newInsightCount}`} />
            <Line label="已移出" value={`${run.archivedInsightCount}`} />
          </div>

          <p className="text-muted-foreground border-t pt-2.5 text-[11px] leading-relaxed">
            {skipped > 0 ? (
              <>
                {skipped} 条已关闭或低信号的反馈未纳入本次分析。{" "}
              </>
            ) : null}
            一旦洞察背后的反馈被标记为已完成或已拒绝，该洞察即被移出。
            {run.model && (
              <>
                {" "}
                由 <span className="font-mono">{run.model}</span> 分析。
              </>
            )}
          </p>
        </PopoverContent>
      </Popover>
    </div>
  );
}
