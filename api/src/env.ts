export interface Env {
  /* Bindings ------------------------------------------------------- */
  DB: D1Database;
  PHOTOS: R2Bucket;

  /* Secrets (wrangler secret put) ---------------------------------- */
  /** Anthropic API key. */
  ANTHROPIC_API_KEY: string;
  /** HMAC key for case tokens and signed image URLs. */
  SIGNING_KEY: string;
  /** SMS provider API key. */
  SMS_API_KEY: string;
  /** Shared with Google Apps Script to authenticate POST /api/lead. */
  LEAD_SECRET: string;
  /** Shared secret for the report-generation webhook (Apps Script). */
  REPORT_SECRET: string;
  /** Shared with the ElevenLabs agent, sent as `x-voice-secret`. */
  VOICE_SECRET: string;

  /* Variables (wrangler.toml) -------------------------------------- */
  /** Public origin of the API, e.g. https://diag-api.soscumulus.fr */
  PUBLIC_API_URL: string;
  /** Origin of the front end, e.g. https://diag.soscumulus.fr */
  PUBLIC_WEB_URL: string;
  /** URL of the Apps Script web app that fills the report template. */
  REPORT_WEBHOOK_URL: string;
  /** Alphanumeric SMS sender registered with the provider. */
  SMS_SENDER: string;
  /** On-call number shown to the client on the safety-stop screen. */
  EMERGENCY_PHONE: string;
  /**
   * SMS send allowlist, comma-separated numbers.
   *
   * Non-empty: only these numbers actually receive a text — every other case
   * is created normally, link included, but nothing is sent. This is the
   * test-phase guard.
   *
   * **Clear this variable to go live.** While it is set, no real client
   * receives their link.
   */
  SMS_ALLOWLIST?: string;
  /** Same shape, applied to texts the voice agent triggers. */
  SMS_ALLOWLIST_VOICE?: string;

  /** Youtrust (ex-Yousign). Sandbox host until real prices exist. */
  YOUTRUST_API_KEY: string;
  YOUTRUST_BASE_URL: string;
  /** Returned once when the webhook subscription is created. */
  YOUTRUST_WEBHOOK_SECRET?: string;
  /** "1" prints invented amounts on a watermarked quote, for demos only. */
  QUOTE_DEMO?: string;
  /** Who receives the intervention request when a quote is signed. */
  INTERVENTION_EMAIL: string;
  /** "true" to log token consumption. */
  LOG_USAGE?: string;
}
