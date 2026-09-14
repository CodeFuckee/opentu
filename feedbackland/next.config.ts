import type { NextConfig } from "next";

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL || "http://10.37.80.25:8021";

// 自建 Supabase Storage 的 public URL 是 http://<host>:<port>/storage/v1/object/public/...，
// 按构建时配置推导远程图片域名，供 next/image 放行。
const supabaseRemotePattern = (() => {
  try {
    const url = new URL(SUPABASE_URL);
    return {
      protocol: (url.protocol.replace(":", "") || "http") as "http" | "https",
      hostname: url.hostname,
      port: url.port || "",
    };
  } catch {
    return { protocol: "http" as const, hostname: "10.37.80.25", port: "8021" };
  }
})();

const nextConfig: NextConfig = {
  output: "standalone",
  images: {
    remotePatterns: [supabaseRemotePattern],
    // 自托管内网部署：Storage 图片地址是私网 IP（10.37.80.x），Next 的 SSRF
    // 防护默认拒绝私网上游（/_next/image 返回 400 "url parameter is not
    // allowed"）。remotePatterns 已白名单限定 Supabase Storage 主机，
    // 此处放开私网限制是安全的。
    dangerouslyAllowLocalIP: true,
  },
};

export default nextConfig;
