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
  },
};

export default nextConfig;
