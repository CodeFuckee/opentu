"server-only";

import { db } from "@/db/db";

/**
 * 回退查询：请求的组织不存在（如从 /login 等非组织页登录）时，
 * 取该用户已加入的组织，使会话仍能绑定到有效组织。
 * 返回结构与 getUserWithRoleAndOrgQuery 一致；无任何组织成员关系时抛错
 * （由调用方兜底），因此返回类型与主查询完全一致。
 */
export const getUserFirstMembershipQuery = async ({
  userId,
}: {
  userId: string;
}) => {
  try {
    return await db
      .selectFrom("user")
      .innerJoin("user_org", "user.id", "user_org.userId")
      .innerJoin("org", "user_org.orgId", "org.id")
      .select([
        "user.id as userId",
        "user.name as userName",
        "user.email as userEmail",
        "user.photoURL as userPhotoURL",
        "user.createdAt as userCreatedAt",
        "user.updatedAt as userUpdatedAt",
        "user_org.role as userRole",
        "org.id as orgId",
        "org.orgSubdomain",
        "org.isClaimed as orgIsClaimed",
        "org.createdAt as orgCreatedAt",
        "org.updatedAt as orgUpdatedAt",
      ])
      .where("user.id", "=", userId)
      .executeTakeFirstOrThrow();
  } catch (error) {
    throw error;
  }
};
