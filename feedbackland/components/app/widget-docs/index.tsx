"use client";

import { useMemo, useState } from "react";
import { FeedbackButton } from "feedbackland-react";
import { ExternalLink } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Code } from "@/components/ui/code";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useIsSelfHosted } from "@/hooks/use-is-self-hosted";
import { useVercelUrl } from "@/hooks/use-vercel-url";
import { usePlatformUrl } from "@/hooks/use-platform-url";
import {
  buildPlaygroundSnippet,
  type Variant,
  type Size,
  type Widget,
} from "@/lib/widget-snippets";

const VARIANT_OPTIONS: { value: Variant; label: string }[] = [
  { value: "default", label: "默认" },
  { value: "secondary", label: "次要" },
  { value: "outline", label: "描边" },
  { value: "ghost", label: "幽灵" },
  { value: "link", label: "链接" },
  { value: "destructive", label: "危险" },
  { value: "unstyled", label: "无样式" },
];

const SIZE_OPTIONS: { value: Size; label: string }[] = [
  { value: "default", label: "默认" },
  { value: "sm", label: "小" },
  { value: "lg", label: "大" },
  { value: "icon", label: "图标" },
  { value: "icon-sm", label: "图标（小）" },
  { value: "icon-lg", label: "图标（大）" },
];

export function WidgetDocs({
  orgId,
  orgSubdomain,
}: {
  orgId: string;
  orgSubdomain: string;
}) {
  const isSelfHosted = useIsSelfHosted();
  const vercelUrl = useVercelUrl();
  const platformUrl = usePlatformUrl();

  const [widget, setWidget] = useState<Widget>("drawer");
  const [text, setText] = useState("Feedback");
  const [variant, setVariant] = useState<Variant>("default");
  const [size, setSize] = useState<Size>("default");
  const [className, setClassName] = useState("");

  // URL baked into the copyable snippet. Hosted customers omit it (the widget
  // resolves the board from `platformId`); self-hosted instances need it
  // explicit so the widget knows where to load the board iframe from.
  const snippetUrl = useMemo(() => {
    if (!isSelfHosted || !vercelUrl) return undefined;
    return `${vercelUrl}/${orgSubdomain}`;
  }, [isSelfHosted, vercelUrl, orgSubdomain]);

  // URL the live preview actually embeds: always the board at the current
  // origin — the admin's own board, whether that's the local dev server, a
  // self-hosted instance, or their hosted subdomain. Without this the preview
  // falls back to the production `<orgId>.feedbackland.com` board that
  // `platformId` alone resolves to, so a local/self-hosted admin would preview
  // (and submit feedback to) the wrong board entirely. Guarded to a valid
  // absolute http(s) URL so a transient null/relative value (e.g. mid HMR
  // reload) is never forwarded to the widget as a malformed `url` prop.
  const previewUrl = useMemo(() => {
    const candidate = platformUrl ?? snippetUrl;
    if (!candidate) return undefined;
    try {
      const { protocol } = new URL(candidate);
      return protocol === "http:" || protocol === "https:"
        ? candidate
        : undefined;
    } catch {
      return undefined;
    }
  }, [platformUrl, snippetUrl]);

  const snippet = useMemo(
    () =>
      buildPlaygroundSnippet({
        orgId,
        url: snippetUrl,
        widget,
        text,
        variant,
        size,
        className,
      }),
    [orgId, snippetUrl, widget, text, variant, size, className],
  );

  return (
    <div className="grid grid-cols-1 items-start gap-8 lg:grid-cols-12">
      {/* Configuration — sticky on wide viewports */}
      <div className="lg:sticky lg:top-8 lg:col-span-4">
        <Card className="bg-background">
          <CardHeader>
            <CardTitle>配置</CardTitle>
            <CardDescription>
              调整各项属性，预览和代码会实时更新。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <Field
              label="组件类型"
              hint={
                widget === "drawer"
                  ? "侧边滑入面板，展示完整看板"
                  : "锚定在页面内的表单，用户不离开当前流程"
              }
              htmlFor="widget-flavor"
            >
              <Tabs
                value={widget}
                onValueChange={(v) => setWidget(v as Widget)}
              >
                <TabsList id="widget-flavor" className="grid w-full grid-cols-2">
                  <TabsTrigger value="drawer">抽屉</TabsTrigger>
                  <TabsTrigger value="popover">弹窗</TabsTrigger>
                </TabsList>
              </Tabs>
            </Field>

            <Field label="按钮文字" hint="按钮上显示的文字" htmlFor="widget-text">
              <Input
                id="widget-text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Feedback"
              />
            </Field>

            <Field
              label="样式变体"
              hint={
                variant === "unstyled"
                  ? "移除内部样式类——请配合 className 使用"
                  : "预设的视觉样式"
              }
              htmlFor="widget-variant"
            >
              <Select
                value={variant}
                onValueChange={(v) => setVariant(v as Variant)}
              >
                <SelectTrigger id="widget-variant">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VARIANT_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field label="尺寸" hint="预设尺寸" htmlFor="widget-size">
              <Select
                value={size}
                onValueChange={(v) => setSize(v as Size)}
              >
                <SelectTrigger id="widget-size">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SIZE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field
              label="Tailwind className"
              hint="可选覆盖——类名冲突时以你的为准"
              htmlFor="widget-classname"
            >
              <Input
                id="widget-classname"
                value={className}
                onChange={(e) => setClassName(e.target.value)}
                placeholder="bg-red-500 rounded-full"
              />
            </Field>

            <p className="text-muted-foreground border-border border-t pt-4 text-xs">
              想使用自己的按钮？可以使用{" "}
              <code className="bg-muted/40 rounded px-1 py-0.5 font-mono text-[11px]">
                asChild
              </code>{" "}
              属性——参见{" "}
              <a
                href="https://github.com/feedbackland/feedbackland/tree/main/feedbackland-react#readme"
                target="_blank"
                rel="noopener noreferrer"
                className="text-foreground inline-flex items-center gap-0.5 underline-offset-4 hover:underline"
              >
                README
                <ExternalLink className="size-3" aria-hidden="true" />
              </a>
              。
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Preview + code */}
      <div className="space-y-4 lg:col-span-8">
        <div className="bg-background overflow-hidden rounded-xl border shadow-xs">
          <div className="bg-muted/20 flex items-center border-b px-4 py-2">
            <span className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
              预览
            </span>
          </div>
          <div className="relative flex min-h-[140px] w-full items-center justify-center px-4 py-8">
            <FeedbackButton
              platformId={orgId}
              url={previewUrl}
              widget={widget}
              text={text || "Feedback"}
              variant={variant}
              size={size}
              className={className || undefined}
            />
          </div>

          <div className="bg-muted/20 flex items-center border-y px-4 py-2">
            <span className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
              安装
            </span>
          </div>
          <Code
            code="npm install feedbackland-react"
            lang="bash"
            className="rounded-none! border-0 border-b"
          />

          <div className="bg-muted/20 flex items-center border-b px-4 py-2">
            <span className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
              用法
            </span>
          </div>
          <Code
            code={snippet}
            lang="tsx"
            className="rounded-none! border-0"
          />
        </div>
      </div>
    </div>
  );
}

/** Compact labelled form field with a one-line hint underneath. */
function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
    </div>
  );
}
