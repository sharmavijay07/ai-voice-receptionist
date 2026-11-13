import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The demo is opened at 127.0.0.1. Next blocks dev assets from that host otherwise.
  allowedDevOrigins: ["127.0.0.1"],
  // Call logs and bookings change on every turn, so the desk is not prerendered.
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
