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
      let errorMessage = "An error occurred. Please try again.";

      // Handle common Supabase auth errors
      if (
        /user not found|user-not-found/i.test(error?.message ?? "") ||
        error?.code === "user_not_found"
      ) {
        errorMessage = "No user found with this email address.";
      } else if (
        /invalid email/i.test(error?.message ?? "") ||
        error?.code === "invalid_email"
      ) {
        errorMessage = "Invalid email address format.";
      } else if (
        /too many/i.test(error?.message ?? "") ||
        error?.code === "over_request_rate_limit"
      ) {
        errorMessage = "Too many attempts. Please try again later.";
      }

      setFormState({ type: "error", message: errorMessage });
    }
  };

  return (
    <div>
      <Button variant="secondary" size="sm" onClick={onGoBack} className="mb-4">
        <ArrowLeft className="size-4" />
        Go back
      </Button>
      <Form {...form}>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
          <FormItem>
            <FormLabel>Email</FormLabel>
            <FormField
              control={control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    <Input
                      autoFocus={true}
                      type="email"
                      placeholder="Email"
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
            Send reset link
          </Button>
        </form>
      </Form>

      {formState.type === "success" && (
        <Success
          title="Password reset email sent"
          description="Please check your email for the password reset link."
          className="mt-4"
        />
      )}

      {formState.type === "error" && formState.message && (
        <Error
          title="Could not sent password reset email"
          description={formState.message}
          className="mt-4"
        />
      )}
    </div>
  );
}
