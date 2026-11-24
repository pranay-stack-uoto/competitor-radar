import headers from './lib/security/headers.js';

export default {
  serverExternalPackages: ['cheerio'],
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: headers.securityHeaders(process.env) }];
  },
};
