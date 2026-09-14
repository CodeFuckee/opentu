"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod/v4";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useCreateAdminInvite } from "@/hooks/use-create-admin-invite";
import { usePlatformUrl } from "@/hooks/use-platform-url";
import { useAuth } from "@/hooks/use-auth";
import { toast } from "sonner";
import { CheckCircle2, Copy } from "lucide-react";
import { useAtom } from "jotai";
import { adminInviteSuccessUrlAtom } from "@/lib/atoms";

const FormSchema = z.object({
  email: z.email(),
});

export function AdminsInvite() {
  const platformUrl = usePlatformUrl();
  const { session } = useAuth();
  const createAdminInvite = useCreateAdminInvite();
  const [successLink, setSuccessLink] = useAtom(adminInviteSuccessUrlAtom);

  const form = useForm<z.infer<typeof FormSchema>>({
    resolver: zodResolver(FormSchema),
    defaultValues: {
      email: "",
    },
  });

  async function onSubmit(formData: z.infer<typeof FormSchema>) {
    try {
      form.clearErrors();

      const result = await createAdminInvite.mutateAsync({
        platformUrl: platformUrl || "",
        email: formData.email,
        invitedBy:
          session?.user?.name ||
          session?.user?.email ||
          "user with unknown name",
      });

      if (result.inviteLink) {
        setSuccessLink(result.inviteLink);
        form.reset();
      }
    } catch (error) {
      let message = "出错了，请重试。";

      if (error instanceof Error) {
        if (error?.message?.toLowerCase()?.includes("invite-email-exists")) {
          message = "该邮箱已被邀请";
        }

        if (error?.message?.toLowerCase()?.includes("admin-email-exists")) {
          message = "该邮箱已经是管理员";
        }
      }

      form.setError("email", {
        message,
      });
    }
  }

  return (
    <div className="mt-6 flex flex-col items-stretch gap-2">
      <Label className="text-muted-foreground">邀请管理员</Label>
      <div className="border-border bg-background rounded-md border p-5 shadow-xs">
        {successLink ? (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2 text-green-600 dark:text-green-500">
              <CheckCircle2 className="h-5 w-5" />
              <p className="font-medium">邀请链接已生成！</p>
            </div>
            <p className="text-muted-foreground text-sm">
              请通过安全的方式将此专属链接分享给新管理员。出于安全考虑，该链接与所填写的邮箱地址绑定。
            </p>
            <div className="flex items-center gap-2">
              <Input
                readOnly
                value={successLink}
                className="w-full font-mono text-sm"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => {
                  navigator.clipboard.writeText(successLink);
                  toast.success("链接已复制到剪贴板", {
                    position: "top-right",
                  });
                }}
              >
                <Copy className="mr-2 h-4 w-4" />
                复制
              </Button>
            </div>
            <div className="mt-2 flex justify-end">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setSuccessLink(null)}
              >
                完成
              </Button>
            </div>
          </div>
        ) : (
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="">
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="sr-only">要邀请的邮箱</FormLabel>
                    <FormControl>
                      <div className="flex flex-row items-center gap-4">
                        <Input
                          type="email"
                          autoFocus={false}
                          className="w-full max-w-[300px] text-sm"
                          placeholder="邮箱地址"
                          {...field}
                        />
                        <Button
                          type="submit"
                          size="sm"
                          className="h-[34px]"
                          loading={createAdminInvite.isPending}
                        >
                          生成链接
                        </Button>
                      </div>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </form>
          </Form>
        )}
      </div>
    </div>
  );
}
