"use client";

import { useState } from "react";
import { SubmitHandler, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod/v4";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormLabel,
  FormItem,
  FormMessage,
} from "@/components/ui/form";
import { Success } from "@/components/ui/success";
import { Error } from "@/components/ui/error";
import { ArrowLeft } from "lucide-react";
import { supabase } from "@/lib/supabase";

const formSchema = z.object({
  email: z.email(),
});

type FormData = z.infer<typeof formSchema>;

export function ForgotPasswordForm({ onGoBack }: { onGoBack: () => void }) {
  const [formState, setFormState] = useState<{
    type: "idle" | "pending" | "success" | "error";
    message?: string;
  }>({ type: "idle" });

  const form = useForm({
    resolver: zodResolver(formSchema),
    defaultValues: {
      email: "",
    },
  });

  const {
    handleSubmit,
    control,
    reset,
    formState: { errors },
  } = form;

  const onSubmit: SubmitHandler<FormData> = async ({ email }) => {
    setFormState({ type: "pending" });

    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.href,
      });
      if (error) throw error;
      setFormState({ type: "success" });
      reset();
    } catch (error: any) {
      let errorMessage = "发生错误，请重试。";

      // Handle common Supabase auth errors
      if (
        /user not found|user-not-found/i.test(error?.message ?? "") ||
        error?.code === "user_not_found"
      ) {
        errorMessage = "未找到使用该邮箱地址的用户。";
      } else if (
        /invalid email/i.test(error?.message ?? "") ||
        error?.code === "invalid_email"
      ) {
        errorMessage = "邮箱地址格式无效。";
      } else if (
        /too many/i.test(error?.message ?? "") ||
        error?.code === "over_request_rate_limit"
      ) {
        errorMessage = "尝试次数过多，请稍后再试。";
      }

      setFormState({ type: "error", message: errorMessage });
    }
  };

  return (
    <div>
      <Button variant="secondary" size="sm" onClick={onGoBack} className="mb-4">
        <ArrowLeft className="size-4" />
        返回
      </Button>
      <Form {...form}>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
          <FormItem>
            <FormLabel>邮箱</FormLabel>
            <FormField
              control={control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    <Input
                      autoFocus={true}
                      type="email"
                      placeholder="邮箱"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage>{errors.email?.message}</FormMessage>
                </FormItem>
              )}
            />
          </FormItem>

          <Button
            type="submit"
            className="w-full"
            loading={formState.type === "pending"}
          >
            发送重置链接
          </Button>
        </form>
      </Form>

      {formState.type === "success" && (
        <Success
          title="密码重置邮件已发送"
          description="请查收邮箱中的密码重置链接。"
          className="mt-4"
        />
      )}

      {formState.type === "error" && formState.message && (
        <Error
          title="密码重置邮件发送失败"
          description={formState.message}
          className="mt-4"
        />
      )}
    </div>
  );
}
