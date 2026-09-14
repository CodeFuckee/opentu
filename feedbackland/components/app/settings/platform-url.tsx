"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod/v4";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { cn, navigateToSubdomain } from "@/lib/utils";
import { useOrg } from "@/hooks/use-org";
import { useUpdateOrg } from "@/hooks/use-update-org";
import { PenIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { orgSubdomainSchema } from "@/lib/schemas";
import { useIsSelfHosted } from "@/hooks/use-is-self-hosted";
import { usePlatformUrl } from "@/hooks/use-platform-url";
import { useVercelUrl } from "@/hooks/use-vercel-url";

const FormSchema = z.object({
  orgSubdomain: orgSubdomainSchema,
});

export function PlatformUrl({
  className,
}: {
  className?: React.ComponentProps<"div">["className"];
}) {
  const isSelfHosted = useIsSelfHosted();
  const platformUrl = usePlatformUrl();
  const vercelUrl = useVercelUrl();

  const {
    query: { data },
  } = useOrg();

  const updateOrg = useUpdateOrg();

  const [isEditing, setIsEditing] = useState(false);

  const form = useForm<z.infer<typeof FormSchema>>({
    resolver: zodResolver(FormSchema),
    defaultValues: {
      orgSubdomain: "",
    },
  });

  useEffect(() => {
    form.setValue("orgSubdomain", data?.orgSubdomain || "");
  }, [form, data]);

  async function onSubmit(formData: z.infer<typeof FormSchema>) {
    try {
      const { orgSubdomain: subdomain } = await updateOrg.mutateAsync({
        orgSubdomain: formData.orgSubdomain,
      });
      navigateToSubdomain({ subdomain });
      setIsEditing(false);
    } catch (error) {
      if (error instanceof Error && error?.message?.includes("duplicate key")) {
        form.setError("orgSubdomain", {
          message: "抱歉，该子域名已被占用",
        });
      } else {
        form.setError("orgSubdomain", {
          message: "出现错误，请重试。",
        });
      }
    }
  }

  const handleOnCancel = () => {
    setIsEditing(false);
    form.setValue("orgSubdomain", data?.orgSubdomain || "");
    form.clearErrors();
  };

  return (
    <div className={cn("", className)}>
      <div className="flex items-start gap-6">
        <div className="flex flex-1 flex-col items-stretch space-y-3">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="">
              <FormField
                control={form.control}
                name="orgSubdomain"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>平台地址</FormLabel>
                    <FormDescription className="">
                      反馈平台的完整地址
                    </FormDescription>
                    <FormControl>
                      {isEditing ? (
                        <div className="flex w-full max-w-[450px] items-center">
                          {isSelfHosted && vercelUrl && (
                            <div className="border-border text-primary bg-muted flex h-[36px] items-center rounded-l-md rounded-r-none border px-3 text-sm">
                              <span>{vercelUrl}/</span>
                            </div>
                          )}
                          <Input
                            autoFocus={true}
                            className={cn("z-10 w-full text-sm", {
                              "rounded-r-none": !isSelfHosted,
                              "rounded-l-none": isSelfHosted,
                            })}
                            placeholder="子域名"
                            {...field}
                          />
                          {!isSelfHosted && (
                            <div className="border-border text-primary bg-muted flex h-[36px] items-center rounded-l-none rounded-r-md border px-3 text-sm">
                              <span>.feedbackland.com</span>
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="text-primary text-sm">
                          {platformUrl}
                        </div>
                      )}
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {isEditing && (
                <div className="mt-3 flex items-center gap-2">
                  <Button type="submit" size="sm" loading={updateOrg.isPending}>
                    保存
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={handleOnCancel}
                  >
                    取消
                  </Button>
                </div>
              )}
            </form>
          </Form>
        </div>
        <div className="-mt-2.5">
          {isEditing ? (
            <Button
              className=""
              size="sm"
              variant="outline"
              onClick={handleOnCancel}
            >
              <XIcon className="size-3.5" />
              取消
            </Button>
          ) : (
            <Button
              className=""
              size="sm"
              variant="outline"
              onClick={() => setIsEditing(true)}
            >
              <PenIcon className="size-3" />
              编辑
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
