/**
 * 登录账号规范化（纯函数；与主应用 apps/web/src/supabase/auth-validation.ts 同规则）
 *
 * 登录使用「OA 账号」：用户输入 oa账号（小写），前端自动拼接 `@yjk.com`
 * 作为 Supabase GoTrue 的登录邮箱（signInWithPassword 只接受 email）。
 */

export const MIN_PASSWORD_LENGTH = 6;

/** OA 账号自动拼接的邮箱域名 */
export const OA_EMAIL_DOMAIN = "yjk.com";

/**
 * 把用户输入的 OA 账号规范化为登录邮箱：
 * - 输入含 `@` → 视为完整邮箱，trim + 小写原样返回；
 * - 否则 → trim + 小写后拼接 `@yjk.com`（如 `zhangsan` → `zhangsan@yjk.com`）。
 */
export function normalizeLoginAccount(input: string): string {
    const trimmed = input.trim().toLowerCase();
    if (!trimmed) {
        return "";
    }
    if (trimmed.includes("@")) {
        return trimmed;
    }
    return `${trimmed}@${OA_EMAIL_DOMAIN}`;
}
