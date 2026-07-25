import type { NextConfig } from "next";
import { resolve } from "node:path";

const scriptSources = [
  "'self'",
  "'unsafe-inline'",
  ...(process.env.NODE_ENV === "development" ? ["'unsafe-eval'"] : []),
].join(" ");

const nextConfig: NextConfig = {
  distDir: process.env.VOISS_MODE === "local" ? ".next-local" : ".next",
  turbopack: {
    root: resolve(import.meta.dirname, "../.."),
  },
  poweredByHeader: false,
  transpilePackages: [
    "@voiss/agent-runtime",
    "@voiss/ag-ui-codex-adapter",
    "@voiss/demo-fixtures",
    "@voiss/domain",
    "@voiss/trust-engine",
  ],
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Content-Security-Policy",
            value: `default-src 'self'; script-src ${scriptSources}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`,
          },
        ],
      },
    ];
  },
};

export default nextConfig;
