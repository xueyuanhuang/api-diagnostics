declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    EVIDENCE: R2Bucket;
    API_KEY_ENCRYPTION_SECRET: string;
    RPM_MAX_REQUESTS_PER_RUN?: string;
  }
}
