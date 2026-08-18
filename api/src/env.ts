export interface Env {
  /* Bindings ------------------------------------------------------- */
  DB: D1Database;
  PHOTOS: R2Bucket;

  /* Secrets (wrangler secret put) ---------------------------------- */
  /** Clé API Anthropic. */
  ANTHROPIC_API_KEY: string;
  /** Clé HMAC des tokens de dossier et des URL d'image signées. */
  SIGNING_KEY: string;
  /** Clé API du fournisseur SMS. */
  SMS_API_KEY: string;
  /** Partagé avec Google Apps Script pour authentifier POST /api/lead. */
  LEAD_SECRET: string;
  /** Secret du webhook de génération de fiche (Apps Script). */
  FICHE_SECRET: string;

  /* Variables (wrangler.toml) -------------------------------------- */
  /** Origine publique de l'API, ex. https://api.diag.soscumulus.fr */
  PUBLIC_API_URL: string;
  /** Origine du front, ex. https://diag.soscumulus.fr */
  PUBLIC_WEB_URL: string;
  /** URL du web app Apps Script qui remplit le template de fiche. */
  FICHE_WEBHOOK_URL: string;
  /** Expéditeur SMS alphanumérique déclaré chez le fournisseur. */
  SMS_SENDER: string;
  /** Numéro affiché au client en cas d'arrêt sécurité. */
  URGENCE_TEL: string;
  /**
   * Liste blanche d'envoi SMS, numéros séparés par des virgules.
   *
   * Non vide : seuls ces numéros reçoivent réellement un SMS — les autres
   * dossiers sont créés normalement, avec leur lien, mais rien ne part. C'est
   * le garde-fou de la phase de test.
   *
   * **Vider cette variable pour la mise en service.** Tant qu'elle est
   * renseignée, aucun client réel ne reçoit son lien.
   */
  SMS_ALLOWLIST?: string;
  /** "true" pour tracer la consommation de tokens. */
  LOG_USAGE?: string;
}
