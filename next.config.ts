import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  allowedDevOrigins: [
    "preview-chat-ed3f2eff-3f7b-431c-b289-69927dfb980e.space.z.ai",
    "*.space.z.ai",
    "*.space.chatglm.site",
    "192.168.68.101",
  ],
};

export default nextConfig;
