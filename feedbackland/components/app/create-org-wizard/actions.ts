"use server";

import { actionClient } from "@/lib/safe-action";
import { createOrgQuery } from "@/queries/create-org";
import { hasClaimedOrgQuery } from "@/queries/has-claimed-org";
import { createOrgSchema } from "./validations";
import { claimOrgSchema } from "@/lib/schemas";
import { claimOrgQuery } from "@/queries/claim-org";
import { getIsSelfHosted } from "@/lib/utils";
import { getSupabaseAdmin } from "@/lib/supabase";

export const createOrgAction = actionClient
  .inputSchema(createOrgSchema)
  .action(async ({ parsedInput: { orgName, orgSubdomain } }) => {
    try {
      // On a self-hosted instance /get-started is a one-time setup step, not a
      // public signup funnel. Once the operator has claimed a board, close the
      // door — otherwise anyone who finds the URL can create orgs (and their
      // seed rows) without limit. The hosted service keeps the funnel open.
      if (getIsSelfHosted("server") && (await hasClaimedOrgQuery())) {
        return {
          success: false,
          message: "此实例已禁用创建组织。",
        };
      }

      const org = await createOrgQuery({ orgName, orgSubdomain });
      return { success: true, org };
    } catch (error) {
      return {
        success: false,
        message:
          error instanceof Error
            ? error?.message
            : "创建组织时发生未知错误",
      };
    }
  });

export const claimOrgAction = actionClient
  .inputSchema(claimOrgSchema)
  .action(async ({ parsedInput: { idToken, orgId } }) => {
    try {
      // Verify the token server-side and take the user id from it. A client could
      // otherwise claim any unclaimed org as any user id it liked, granting
      // itself (or someone else) admin.
      const { data, error } = await getSupabaseAdmin().auth.getUser(idToken);

      if (error || !data.user) {
        throw new Error("会话令牌无效");
      }

      const org = await claimOrgQuery({ userId: data.user.id, orgId });

      return { success: true, org };
    } catch (error) {
      return {
        success: false,
        message:
          error instanceof Error
            ? error?.message
            : "认领组织时发生未知错误",
      };
    }
  });
