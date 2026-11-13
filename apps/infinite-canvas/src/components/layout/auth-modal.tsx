import { App, Button, Form, Input, Modal } from "antd";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useAuthStore } from "@/stores/use-auth-store";

type AuthFormValues = { account: string; password: string };

/** 登录弹窗（全局唯一实例，挂载于 AppProviders；登录门禁与顶栏按钮共用开关） */
export function AuthModal() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const open = useAuthStore((state) => state.loginModalOpen);
    const setLoginModalOpen = useAuthStore((state) => state.setLoginModalOpen);
    const signIn = useAuthStore((state) => state.signIn);
    const [form] = Form.useForm<AuthFormValues>();
    const [submitting, setSubmitting] = useState(false);

    const close = () => {
        setLoginModalOpen(false);
        form.resetFields();
    };

    const submit = async () => {
        const values = await form.validateFields();
        setSubmitting(true);
        try {
            const error = await signIn(values.account, values.password);
            if (error) {
                message.error(t("auth.loginFailed", { message: error }));
                return;
            }
            message.success(t("auth.loginSuccess"));
            close();
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Modal open={open} width={380} centered title={t("auth.loginTitle")} onCancel={close} footer={null} destroyOnHidden>
            <Form form={form} layout="vertical" onFinish={() => void submit()}>
                <Form.Item name="account" label={t("auth.account")} rules={[{ required: true, message: t("auth.accountRequired") }]}>
                    <Input placeholder={t("auth.accountPlaceholder")} autoFocus autoComplete="username" />
                </Form.Item>
                <Form.Item
                    name="password"
                    label={t("auth.password")}
                    rules={[
                        { required: true, message: t("auth.passwordRequired") },
                        { min: 6, message: t("auth.passwordMin") },
                    ]}
                >
                    <Input.Password placeholder={t("auth.passwordPlaceholder")} autoComplete="current-password" />
                </Form.Item>
                <Button type="primary" htmlType="submit" block loading={submitting}>
                    {t("auth.login")}
                </Button>
            </Form>
            <div className="mt-3 text-xs text-stone-500">{t("auth.hint")}</div>
        </Modal>
    );
}
