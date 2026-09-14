"use client";

import { z } from "zod/v4";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { useForm, SubmitHandler } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { Session } from "@/hooks/use-auth";

export const signUpSchema = z.object({
  name: z.string().min(1, "请输入用户名"),
  email: z.email().min(1, "请输入邮箱地址"),
  password: z
    .string()
    .trim()
    .min(8, "密码长度至少为 8 个字符")
    .max(128, "密码长度不能超过 128 个字符"),
});

type FormData = z.infer<typeof signUpSchema>;

export function SignUpEmailForm({
  onSuccess,
  onClose,
}: {
  onSuccess: (session: Session) => void;
  onClose?: () => void;
}) {
  const [isPending, setIsPending] = useState(false);

  const form = useForm<FormData>({
    resolver: zodResolver(signUpSchema),
    defaultValues: {
      name: "",
      email: "",
      password: "",
    },
  });

  const { signUpWithEmail } = useAuth();

  const {
    formState: { errors },
    setError,
    clearErrors,
  } = form;

  const onSubmit: SubmitHandler<FormData> = async ({
    name,
    email,
    password,
  }) => {
    clearErrors("root.serverError");

    setIsPending(true);

    try {
      const session = await signUpWithEmail({
        name,
        email,
        password,
      });
      onSuccess(session);
    } catch (error: any) {
      let message = "发生错误，请重试";

      if (error?.message?.includes("email-already-in-use")) {
        message = "该邮箱已被使用，请直接登录。";
      }

      setError("root.serverError", {
        message,
      });
    } finally {
      setIsPending(false);
    }
  };

  return (
    <div>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => onClose?.()}
        className="mb-4"
      >
        <ArrowLeft className="size-4" />
        返回
      </Button>
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
          {errors?.root?.serverError && (
            <p className="text-destructive">
              {errors?.root?.serverError.message}
            </p>
          )}
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>用户名</FormLabel>
                <FormControl>
                  <Input
                    autoFocus
                    placeholder="用户名"
                    {...field}
                    type="text"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>邮箱</FormLabel>
                <FormControl>
                  <Input placeholder="邮箱" {...field} type="email" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="password"
            render={({ field }) => (
              <FormItem>
                <FormLabel>密码</FormLabel>
                <FormControl>
                  <Input placeholder="密码" {...field} type="password" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <Button type="submit" className="w-full" loading={isPending}>
            注册
          </Button>
        </form>
      </Form>
    </div>
  );
}
