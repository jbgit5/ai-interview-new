/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // react-pdf runs in Node.js (Route Handlers) — exclude from webpack bundling.
    // pdf-parse (pdfjs) and mammoth parse uploaded CVs server-side; bundling pdfjs breaks its worker.
    serverComponentsExternalPackages: ["@react-pdf/renderer", "pdf-parse", "mammoth"],
  },
};

export default nextConfig;
