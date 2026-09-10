import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  reactStrictMode: false,
  output: "standalone",
  async redirects() {
    return [
      { source: "/guide/auto-layout", destination: "/how-auto-layout-works", permanent: true },
    ];
  },
};

export default nextConfig;
