import superjson from "superjson";
import { initTRPC, TRPCError } from "@trpc/server";
import z, { ZodError } from "zod/v4";
import { getUserWithRoleAndOrgQuery } from "@/queries/get-user-with-role-and-org";
import { getOrgQuery } from "@/queries/get-org";
import { UserRole } from "@/lib/typings";
import { getClientIp } from "@/lib/rate-limit";
import { getSupabaseAdmin } from "@/lib/supabase";

const getSupabaseUser = async (req: Request) => {
  const authorization = req.headers.get("authorization");
  const accessToken = authorization?.split(" ")?.[1];

  if (!accessToken) return null;

  try {
    const { data, error } = await getSupabaseAdmin().auth.getUser(accessToken);
    return error ? null : data.user;
  } catch {
    return null;
  }
};

export const createContext = async ({ req }: { req: Request }) => {
  const orgSubdomain = req?.headers?.get("subdomain");
  const ip = getClientIp(req.headers);
  const supabaseUser = await getSupabaseUser(req);
  const userId = supabaseUser?.id || null;
  const userEmail = supabaseUser?.email || null;
  let orgId: string | null | undefined;
  let orgIsClaimed: boolean | null | undefined;
  let userRole: UserRole | null | undefined;

  if (orgSubdomain) {
    // not signed in
    if (!userId) {
      const org = await getOrgQuery({ orgSubdomain });
      orgId = org?.id;
      orgIsClaimed = org?.isClaimed;
    }
    // signed in
    else {
      const userWithRoleAndOrg = await getUserWithRoleAndOrgQuery({
        userId,
        orgSubdomain,
      });

      orgId = userWithRoleAndOrg?.orgId;
      orgIsClaimed = userWithRoleAndOrg?.orgIsClaimed;
      userRole = userWithRoleAndOrg?.userRole;
    }
  }

  return {
    orgId,
    orgSubdomain,
    orgIsClaimed,
    userId,
    userEmail,
    userRole,
    ip,
  };
};

export type Context = typeof createContext;

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        zodError:
          error.cause instanceof ZodError ? z.flattenError(error.cause) : null,
      },
    };
  },
});

const publicProcedureMiddleware = t.middleware((opts) => {
  const { ctx } = opts;

  if (!ctx?.orgId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "No orgId was found",
    });
  }

  return opts.next({
    ...opts,
    ctx: {
      ...ctx,
      orgId: ctx.orgId,
    },
  });
});

const userProcedureMiddleware = publicProcedureMiddleware.unstable_pipe(
  (opts) => {
    const { ctx } = opts;

    if (!ctx.userId) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "No userId was found",
      });
    }

    return opts.next({
      ...opts,
      ctx: {
        ...ctx,
        userId: ctx.userId,
      },
    });
  },
);

const adminProcedureMiddleware = userProcedureMiddleware.unstable_pipe(
  (opts) => {
    const { ctx } = opts;

    if (ctx.userRole !== "admin") {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "User does not have admin role",
      });
    }

    return opts.next({
      ...opts,
      ctx: {
        ...ctx,
        userRole: ctx.userRole,
      },
    });
  },
);

export const router = t.router;
export const publicProcedure = t.procedure.use(publicProcedureMiddleware);
export const userProcedure = t.procedure.use(userProcedureMiddleware);
export const adminProcedure = t.procedure.use(adminProcedureMiddleware);
