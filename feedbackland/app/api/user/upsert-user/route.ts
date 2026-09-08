import { upsertUserSchema } from "@/lib/schemas";
import { upsertUserQuery as upsertUserQuery } from "@/queries/upsert-user";
import { getSupabaseAdmin } from "@/lib/supabase";
import { NextResponse, type NextRequest } from "next/server";

export async function POST(request: NextRequest) {
  try {
    // 服务端校验 token，用户身份一律以 token 为准，不再信任客户端传来的
    // userId/email（原实现未认证直写，任何人可伪造任意用户写库）。
    const accessToken =
      request.headers.get("authorization")?.split(" ")?.[1] ?? null;

    if (!accessToken) {
      return NextResponse.json(
        { error: "Missing session token" },
        { status: 401 },
      );
    }

    const { data, error } = await getSupabaseAdmin().auth.getUser(accessToken);

    if (error || !data.user) {
      return NextResponse.json(
        { error: "Invalid session token" },
        { status: 401 },
      );
    }

    const verifiedUser = data.user;
    const bodyRaw = await request.json();
    const { orgSubdomain, name, photoURL } = upsertUserSchema.parse(bodyRaw);

    const user = await upsertUserQuery({
      userId: verifiedUser.id,
      orgSubdomain,
      email: verifiedUser.email ?? `${verifiedUser.id}@no-email.com`,
      name,
      photoURL,
    });

    return NextResponse.json(user);
  } catch (error) {
    return NextResponse.json(
      {
        error: `Failed to upsert user: ${error instanceof Error ? error?.message : `Unknown error`}`,
      },
      { status: 500 },
    );
  }
}
