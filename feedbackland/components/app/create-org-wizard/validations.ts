import { z } from "zod/v4";
import { orgSubdomainSchema } from "@/lib/schemas";

export const createOrgSchema = z.object({
  orgName: z
    .string()
    .trim()
    .min(1, "请输入组织或产品名称")
    .max(200, "组织或产品名称不能超过 200 个字符"),
  orgSubdomain: orgSubdomainSchema,
});
