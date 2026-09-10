"server-only";

import { db } from "@/db/db";
import { UpsertUser } from "@/lib/typings";

export const upsertUserQuery = async (args: UpsertUser) => {
  try {
    const { userId, orgSubdomain, name, photoURL } = args;
    const email = args.email.toLowerCase();

    return await db.transaction().execute(async (trx) => {
      let org = await trx
        .selectFrom("org")
        .where("org.orgSubdomain", "=", orgSubdomain)
        .selectAll()
        .executeTakeFirst();

      if (!org) {
        // 请求的组织不存在（如从 /login 等非组织页登录）：回退到该用户
        // 已加入的组织，避免登录直接进入坏状态；从未加入任何组织的用户
        // 仍需从组织看板（/:orgSubdomain）进入
        const membership = await trx
          .selectFrom("user_org")
          .where("user_org.userId", "=", userId)
          .selectAll()
          .executeTakeFirst();

        if (!membership) {
          throw new Error(
            `org "${orgSubdomain}" does not exist and the user has no membership`
          );
        }
        org = await trx
          .selectFrom("org")
          .where("org.id", "=", membership.orgId)
          .selectAll()
          .executeTakeFirstOrThrow();
      }

      const orgId = org.id;

      let user = await trx
        .selectFrom("user")
        .where("user.id", "=", userId)
        .selectAll()
        .executeTakeFirst();

      if (!user || !!(user && !user.name && name)) {
        user = await trx
          .insertInto("user")
          .values({
            id: userId,
            email,
            name,
            photoURL,
          })
          .onConflict((oc) =>
            oc.column("id").doUpdateSet({
              name,
            }),
          )
          .returningAll()
          .executeTakeFirstOrThrow();
      }

      let userOrg = await trx
        .selectFrom("user_org")
        .where("userId", "=", userId)
        .where("orgId", "=", orgId)
        .selectAll()
        .executeTakeFirst();

      if (!userOrg) {
        userOrg = await trx
          .insertInto("user_org")
          .values({
            userId,
            orgId,
            role: "user",
          })
          .onConflict((oc) =>
            oc.columns(["userId", "orgId"]).doUpdateSet({
              orgId,
            }),
          )
          .returningAll()
          .executeTakeFirstOrThrow();
      }

      return { user, userOrg, org };
    });
  } catch (error) {
    throw error;
  }
};
