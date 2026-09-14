"use client";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  SCORE_WEIGHTS,
  clamp,
  getPriorityDelta,
  getSignalDriver,
} from "@/lib/insights";
import type { Insight } from "@/lib/typings";

/** lib 里 driver / effort 标签为英文，这里只做展示层映射。 */
const DRIVER_LABELS_CN: Record<string, string> = {
  "Widely asked": "涉及面广",
  Surging: "热度上升",
  Severe: "问题严重",
};

const EFFORT_LABELS_CN: Record<string, string> = {
  s: "小",
  m: "中",
  l: "大",
};

/**
 * One component of the score. A single hue across all three bars: they measure
 * different things but the same quantity — how much this insight has of it — so
 * colouring them apart would imply a distinction that is not there.
 *
 * The weight sits in the label rather than in a hover title, because how much
 * each part counts is half of what this panel is here to explain.
 */
function ScoreBar({
  label,
  detail,
  value,
  weight,
}: {
  label: string;
  detail: string;
  value: number;
  weight: number;
}) {
  return (
    <div className="grid grid-cols-[7rem_1fr_1.75rem] items-center gap-2">
      <div className="min-w-0">
        <div className="truncate text-xs font-medium">
          {label}{" "}
          <span className="text-muted-foreground font-normal tabular-nums">
            {Math.round(weight * 100)}%
          </span>
        </div>
        <div className="text-muted-foreground truncate text-[11px]">
          {detail}
        </div>
      </div>

      {/* Decorative: the label, the detail and the number beside it already say
          everything the bar says. */}
      <div
        aria-hidden
        className="bg-foreground/10 h-1.5 overflow-hidden rounded-full"
      >
        <div
          className="bg-foreground/70 h-full rounded-full"
          style={{ width: `${clamp(value, 2, 100)}%` }}
        />
      </div>

      <div className="text-muted-foreground text-right text-xs tabular-nums">
        {Math.round(value)}
      </div>
    </div>
  );
}

/**
 * How strong the case for an insight is, without asking anyone to interpret a
 * number out of 100.
 *
 * The meter is the whole point: read down the right edge and the list's falloff
 * is obvious at a glance, with no scale to learn. A word appears beside it only
 * when one of the three signals clearly leads — then it says *why* this one is
 * up here. Most rows show the meter alone, which is what keeps the column calm.
 * The number, and the arithmetic behind it, live one click away.
 */
export function InsightSignal({ insight }: { insight: Insight }) {
  const signals = insight.signals;
  const delta = getPriorityDelta(insight);
  const driver = getSignalDriver(insight);

  // Five discrete bars rather than a continuous fill: at this size a segmented
  // meter reads as signal strength at a glance, where a 36px sliver of colour
  // just reads as a dash.
  const filled = clamp(Math.ceil(insight.priority / 20), 1, 5);

  const meter = (
    <>
      {driver && (
        <span className="text-muted-foreground xs:inline hidden text-xs font-medium whitespace-nowrap select-none">
          {DRIVER_LABELS_CN[driver] ?? driver}
        </span>
      )}
      <span aria-hidden className="flex shrink-0 items-end gap-[3px]">
        {[0, 1, 2, 3, 4].map((index) => (
          <span
            key={index}
            className={cn(
              "w-[3px] rounded-[1px] transition-colors",
              // Rising heights make the meter legible even in a single glance
              // and even without colour.
              ["h-1.5", "h-2", "h-2.5", "h-3", "h-3.5"][index],
              index < filled
                ? "bg-foreground/80 group-hover/signal:bg-foreground"
                : "bg-foreground/15",
            )}
          />
        ))}
      </span>
    </>
  );

  // The negative right margin lands the last bar on the row's content edge, so
  // the meters line up with the status controls below them.
  const shell =
    "-mr-1.5 flex shrink-0 items-center gap-2 rounded-md px-1.5 py-1";

  // Rows written before the score was broken down have nothing to explain, so
  // they show the meter without pretending to be interactive.
  if (!signals) {
    return (
      <span
        className={shell}
        title={`优先级 ${insight.priority} / 100`}
        aria-label={`优先级 ${insight.priority} / 100`}
      >
        {meter}
      </span>
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`优先级 ${insight.priority} / 100。查看计算方式。`}
          className={cn(
            shell,
            "group/signal hover:bg-muted focus-visible:ring-ring transition-colors focus-visible:ring-2 focus-visible:outline-none",
          )}
        >
          {meter}
        </button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-80 space-y-3">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm font-semibold">
            优先级 {insight.priority}
          </span>
          {delta !== null && (
            <span className="text-muted-foreground text-xs tabular-nums">
              较上次分析{delta > 0 ? "+" : ""}
              {delta}
            </span>
          )}
        </div>

        <div className="space-y-2.5">
          <ScoreBar
            label="触达"
            detail={`${signals.reach} 人`}
            value={signals.reachScore}
            weight={SCORE_WEIGHTS.reach}
          />
          <ScoreBar
            label="势头"
            detail={`30 天内 ${signals.recentUpvotes + signals.recentCommentCount} 次互动`}
            value={signals.momentumScore}
            weight={SCORE_WEIGHTS.momentum}
          />
          <ScoreBar
            label="严重程度"
            detail="对单个用户的影响"
            value={signals.severityScore}
            weight={SCORE_WEIGHTS.severity}
          />
        </div>

        <p className="text-muted-foreground border-t pt-2.5 text-[11px] leading-relaxed">
          触达和势头都是与本次分析中最强的洞察对比打分。触达按独立用户计数，同一人重复顶帖只计一次。严重程度是模型对问题本身的判断，而非对需求量的判断。
          {insight.effort && signals.effortMultiplier !== 1 && (
            <>
              {" "}
              工作量为“{EFFORT_LABELS_CN[insight.effort]}”的洞察会应用{" "}
              <span className="tabular-nums">
                ×{signals.effortMultiplier.toFixed(2)}
              </span>{" "}
              的调整系数。
            </>
          )}
        </p>
      </PopoverContent>
    </Popover>
  );
}
