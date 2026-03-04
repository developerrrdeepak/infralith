import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  /* config options here */
  typescript: {
    // We enforce TypeScript via `npm run typecheck` before build.
    // This avoids duplicate typecheck process spawning during `next build`.
    ignoreBuildErrors: true,
  },


  experimental: {
    serverActions: {
      bodySizeLimit: '100mb',
    },
  },
  turbopack: {},
  output: 'standalone',
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'placehold.co',
        port: '',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: 'picsum.photos',
        port: '',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: 'images.unsplash.com',
        port: '',
        pathname: '/**',
      },
    ],
  },
};

export default nextConfig;
