"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Error } from "@/components/ui/error";
import { Spinner } from "@/components/ui/spinner";
import { useInsights } from "@/hooks/use-insights";
import { useGenerateInsights } from "@/hooks/use-generate-insights";
import { InsightsHeader } from "./header";
import { InsightsRunStrip } from "./run-strip";
import { InsightsSearch } from "./search";
import { InsightRow } from "./insight-row";
import { InsightsLoading } from "./loading";
import {
  InsightsFirstRun,
  InsightsNoFeedback,
  InsightsNoMatches,
} from "./empty";

/** Below this many insights the whole list fits on screen, so search is noise. */
const SEARCH_THRESHOLD = 8;

export function Insights() {
  const [search, setSearch] = useState("");
  const {
    query: { data, isPending, isError },
  } = useInsights();
  const generate = useGenerateInsights();

  const insights = useMemo(() => data?.insights ?? [], [data?.insights]);
  const run = data?.run ?? null;

  const handleGenerate = () => {
    generate.mutate(undefined, {
      onSuccess: () =>
        toast.success("洞察已更新", { position: "top-right" }),
      onError: (error) =>
        toast.error(error.message || "分析未能完成。", {
          position: "top-right",
        }),
    });
  };

  // The whole insights is in memory, so search runs over every insight rather
  // than over whatever happened to be loaded.
  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return insights;

    return insights.filter(
      (insight) =>
        insight.title.toLowerCase().includes(term) ||
        insight.description.toLowerCase().includes(term) ||
        (insight.signals?.evidence ?? "").toLowerCase().includes(term),
    );
  }, [insights, search]);

  if (isPending) return <InsightsLoading />;

  if (isError) {
    return (
      <div>
        <h2 className="h5 mb-4">洞察</h2>
        <Error
          title="无法加载你的洞察"
          description="读取洞察时出现问题，请刷新页面重试。"
        />
      </div>
    );
  }

  const isGenerating = generate.isPending;
  const openPostCount = data?.openPostCount ?? 0;

  if (insights.length === 0) {
    return (
      <div>
        {/* No action up here: the empty state below is the call to action, and
            when there is no feedback at all there is nothing to act on. */}
        <InsightsHeader hasRun={!!run} />
        {isGenerating ? (
          <InsightsLoading showHeader={false} />
        ) : openPostCount === 0 ? (
          <InsightsNoFeedback />
        ) : (
          <InsightsFirstRun
            onGenerate={handleGenerate}
            isGenerating={isGenerating}
            postCount={openPostCount}
          />
        )}
      </div>
    );
  }

  return (
    <div>
      <InsightsHeader
        hasRun={!!run}
        onGenerate={handleGenerate}
        isGenerating={isGenerating}
      />

      {isGenerating && (
        <div
          role="status"
          className="border-border bg-muted/40 text-muted-foreground mb-4 flex items-center gap-2.5 rounded-lg border px-4 py-3 text-sm"
        >
          <Spinner className="size-4 shrink-0" />
          <span>
            正在读取你的反馈。在新洞察就绪之前，下方内容会保持不变。
          </span>
        </div>
      )}

      {insights.length >= SEARCH_THRESHOLD && (
        <InsightsSearch
          value={search}
          onChange={setSearch}
          matchCount={visible.length}
          total={insights.length}
        />
      )}

      <div className="border-border bg-background overflow-hidden rounded-lg border shadow-xs">
        {run && <InsightsRunStrip run={run} />}

        {visible.map((insight) => (
          <InsightRow key={insight.id} insight={insight} />
        ))}

        {visible.length === 0 && (
          <InsightsNoMatches onClear={() => setSearch("")} />
        )}
      </div>
    </div>
  );
}
