/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // react-pdf runs in Node.js (Route Handlers) — exclude from webpack bundling
    serverComponentsExternalPackages: ["@react-pdf/renderer"],
  },
};

export default nextConfig;
