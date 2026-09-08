"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Method, SignUpIn } from "@/components/app/sign-up-in";
import { useAction } from "next-safe-action/hooks";
import { claimOrgAction } from "./actions";
import { CreateOrgWrapper } from "./wrapper";
import { useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/lib/supabase";

export function CreateOrgClaim({ onSuccess }: { onSuccess: () => void }) {
  const { refreshSession } = useAuth();
  const [selectedMethod, setSelectedMethod] = useState<Method>("sign-up");
  const { executeAsync: claimOrg } = useAction(claimOrgAction);

  return (
    <CreateOrgWrapper>
      <Card className="w-full max-w-[420px]">
        <CardHeader>
          <CardTitle className="h3 mt-1 mb-3 text-center font-bold">
            Create your account
          </CardTitle>
        </CardHeader>
        <CardContent>
          <SignUpIn
            selectedMethod={selectedMethod}
            onSelectedMethodChange={(newSelectedMethod) =>
              setSelectedMethod(newSelectedMethod)
            }
            onSuccess={async (session) => {
              const orgId = session?.org?.id;
              // Sign-in just resolved, so a session is available. Send its access
              // token and let the server derive the user id — the claim grants
              // admin, so the client can't be trusted to name the user itself.
              const {
                data: { session: currentSession },
              } = await supabase.auth.getSession();
              const accessToken = currentSession?.access_token;

              if (accessToken && orgId) {
                await claimOrg({
                  idToken: accessToken,
                  orgId,
                });

                await refreshSession();

                onSuccess();
              }
            }}
          />
        </CardContent>
      </Card>
    </CreateOrgWrapper>
  );
}
