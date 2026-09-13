import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // TypeScript 7 dropped the JS API Next.js normally uses for type checking,
    // so run the local tsc CLI instead. https://github.com/vercel/next.js/pull/95639
    useTypeScriptCli: true,
  },
};

export default nextConfig;
