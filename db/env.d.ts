declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    APP_ORIGIN?: string;
    GOOGLE_CLIENT_ID?: string;
    GALLERY_OWNER_EMAIL_SHA256?: string;
    GOOGLE_CLIENT_SECRET?: string;
    EVIDENCE: R2Bucket;
    API_KEY_ENCRYPTION_SECRET: string;
    RPM_MAX_REQUESTS_PER_RUN?: string;
  }
}
