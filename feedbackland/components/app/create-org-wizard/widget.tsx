"use client";

import { Button } from "@/components/ui/button";
import { WidgetDocs } from "@/components/app/widget-docs";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ArrowRight } from "lucide-react";
import { CreateOrgWrapper } from "./wrapper";
import { useOrg } from "@/hooks/use-org";

export function CreateOrgWidget({ onSuccess }: { onSuccess: () => void }) {
  const {
    query: { data: org },
  } = useOrg();

  if (org && org?.id && org?.orgSubdomain) {
    return (
      <CreateOrgWrapper>
        <Card className="w-full max-w-[750px]">
          <CardHeader>
            <CardTitle className="h3 mt-1 mb-3 text-center font-bold">
              为你的应用添加反馈按钮
            </CardTitle>
            <CardDescription className="text-primary mx-auto max-w-lg text-center">
              开始收集应用内反馈
            </CardDescription>
          </CardHeader>
          <CardContent>
            <WidgetDocs orgId={org.id} orgSubdomain={org.orgSubdomain} />
            <div className="mt-9">
              <Button onClick={() => onSuccess()} className="w-full">
                前往你的平台
                <ArrowRight />
              </Button>
            </div>
          </CardContent>
        </Card>
      </CreateOrgWrapper>
    );
  }
}
