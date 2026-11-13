/**
 * 登录门禁（模块级函数，不依赖 hook 上下文）
 *
 * 生成入口统一在 isAiConfigReady 判定之前调用 ensureLoggedIn()：
 * 未登录 → 打开登录框 + 提示，返回 false 供调用方中断生成流程。
 * UI 通知经 setAuthGateNotifier 注入（AppProviders 挂载时接 antd message），
 * 使本函数可在任意回调/非组件上下文直接调用。
 */
import i18n from "@/i18n";
import { useAuthStore } from "@/stores/use-auth-store";

type AuthGateNotifier = (message: string) => void;

let notifier: AuthGateNotifier | null = null;

/** AppProviders 挂载时注入 antd message 实例（幂等） */
export function setAuthGateNotifier(fn: AuthGateNotifier | null) {
    notifier = fn;
}

/**
 * 登录门禁：已登录返回 true；未登录（含会话恢复中）打开登录框、提示并返回 false。
 */
export function ensureLoggedIn(): boolean {
    if (useAuthStore.getState().status === "authenticated") return true;
    notifier?.(i18n.t("auth.loginRequired"));
    useAuthStore.getState().setLoginModalOpen(true);
    return false;
}
