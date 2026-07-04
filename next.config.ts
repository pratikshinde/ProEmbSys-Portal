import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  allowedDevOrigins: [
    "preview-chat-ed3f2eff-3f7b-431c-b289-69927dfb980e.space.z.ai",
    "*.space.z.ai",
    "*.space.chatglm.site",
  ],
};

export default nextConfig;
