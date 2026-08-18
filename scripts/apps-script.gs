/**
 * SOS Cumulus — Callback form backend + Diag Express bridge (Google Apps Script).
 *
 * On each form submission from the website, this script:
 *   1) appends a row to the "Leads" Google Sheet
 *   2) sends an HTML email to the recipients
 *   3) asks the Diag API to open a remote-diagnosis file and text the client
 *
 * It also answers two callbacks from the Diag API:
 *   - "fiche"           → fills a Docs template, archives the media to Drive
 *   - "alerte_securite" → emails the team immediately when a hazard is declared
 *
 * DEPLOYMENT (once):
 *   1. Open the "Leads" Sheet → Extensions → Apps Script.
 *   2. Paste this code (replace everything), set RECIPIENTS below, Save.
 *   3. Project Settings → Script Properties, add:
 *        API_URL       https://diag-api.soscumulus.fr
 *        LEAD_SECRET   same value as the Worker secret (see api/.dev.vars)
 *        FICHE_SECRET  same value as the Worker secret
 *        TEMPLATE_ID   id of the Google Docs template
 *        DOSSIER_ID    id of the Drive folder holding intervention files
 *        ARCHIVE_ANS   2
 *   4. Deploy → New deployment → type "Web app".
 *        - Execute as: Me
 *        - Who has access: Anyone
 *      → Authorize the requested Google scopes, copy the "/exec" URL.
 *   5. Use that URL in the website (SITE.formEndpoint) AND in the Worker's
 *      FICHE_WEBHOOK_URL variable (api/wrangler.toml).
 *   6. Triggers → Add trigger → purgerArchives → Time-driven → Month timer.
 *      Without it, the 2-year retention promised to the client is not kept.
 *
 * Storage split: R2 is a seven-day working buffer for upload, analysis and
 * signed URLs. Drive is the durable archive. The signed links received here
 * expire with the file, hence the copy rather than storing the URLs.
 */

// === CONFIG ===
var SHEET_ID = "16pXO1yZxyarJZZ16UfgOVjk8znPTrjJJO8tb5Xbakts"; // "SOS Cumulus — Leads" Sheet
var RECIPIENTS = [
  // === TEST PHASE: only this recipient is active ===
  "maxime.peron+soscumulus@gmail.com",
  "contact.buzzimmo+soscumulus@gmail.com",
  "anthonymazaud.am+soscumulus@gmail.com",
  "tayarlena6+soscumulus@gmail.com",
];

// Column F "Statut": allowed values + color (red→green gradient by progress).
// The first value is applied by default to every new request.
var STATUSES = [
  { label: "À rappeler",             bg: "#F4C7C3", fg: "#5B0F00" }, // red — to handle
  { label: "Rappelé",                bg: "#FCE5CD", fg: "#7F4F00" }, // orange
  { label: "Planifier intervention", bg: "#FFF2CC", fg: "#7F6000" }, // yellow
  { label: "Intervention planifiée", bg: "#D0E0E3", fg: "#0C343D" }, // blue/teal
  { label: "Intervention réalisée",  bg: "#D9EAD3", fg: "#274E13" }, // green — done
];
var DEFAULT_STATUS = STATUSES[0].label; // "À rappeler"

// Secrets and ids live in Script Properties, never in this file.
var P = PropertiesService.getScriptProperties();

// Site palette, shared by every email this script sends.
var NAVY = "#1B3A5C", NAVY_DEEP = "#0F2440", ORANGE = "#FF5B29", RED = "#C62828";
var INK = "#1E293B", GRAY = "#64748B", LINE = "#E4EBF1", ICE = "#DEEAF1", OFFWHITE = "#F8FAFC";
// ==============

function doPost(e) {
  try {
    // The Diag API authenticates with a secret in the query string: doPost does
    // not expose custom headers, so the header form is not an option here.
    var secret = (e && e.parameter && e.parameter.secret) || "";
    if (secret) return handleApiCallback(e, secret);

    return handleFormSubmission(e);
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

function doGet() {
  return ContentService.createTextOutput("SOS Cumulus — endpoint formulaire OK");
}

/* ------------------------------------------------------------------ */
/* 1. Website form                                                     */
/* ------------------------------------------------------------------ */

function handleFormSubmission(e) {
  var p = (e && e.parameter) || {};
  var tel = String(p.tel || "").trim();
  var probleme = String(p.probleme || "").trim();
  var ville = String(p.ville || "").trim();
  var page = String(p.page || "").trim();
  var now = new Date();

  // Open the diagnosis file first: its link is worth having in both the Sheet
  // row and the email. A failure here must never cost us the lead, so it is
  // caught and the rest of the flow carries on unchanged.
  var diag = ouvrirDiagnostic(tel, ville, probleme);

  // 1) Write to the Sheet (first tab) — column F = default status
  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
  sheet.appendRow([now, tel, probleme, ville, page, DEFAULT_STATUS, diag.url || ""]);
  // Force column B (phone) to text so the leading 0 is kept (06…, 04…).
  var lastRow = sheet.getLastRow();
  sheet.getRange(lastRow, 2).setNumberFormat("@").setValue(tel);

  // 2) Email to recipients (HTML in the site's colors + plain-text fallback)
  var receivedAt = Utilities.formatDate(now, "Europe/Paris", "dd/MM/yyyy 'à' HH:mm");
  var data = {
    tel: tel,
    probleme: probleme || "Non précisé",
    ville: ville || "Non précisée",
    page: page || "/",
    receivedAt: receivedAt,
    diagUrl: diag.url || "",
    diagRef: diag.ref || "",
    smsSent: diag.smsSent === true,
  };
  var subject = "🔔 Nouvelle demande de rappel — " + (ville || "ville non précisée");
  var textBody =
    "Nouvelle demande via le formulaire SOS Cumulus :\n\n" +
    "Téléphone : " + tel + "\n" +
    "Type de problème : " + data.probleme + "\n" +
    "Ville : " + data.ville + "\n" +
    "Page d'origine : " + data.page + "\n" +
    "Reçue le : " + receivedAt + "\n" +
    (data.diagUrl
      ? "\nDiagnostic à distance " + data.diagRef + " : " + data.diagUrl +
        "\nSMS au client : " + (data.smsSent ? "envoyé" : "NON ENVOYÉ — à relancer à la main") + "\n"
      : "\nDiagnostic à distance : non ouvert (API injoignable)\n");

  MailApp.sendEmail({
    to: RECIPIENTS.join(","),
    subject: subject,
    body: textBody,
    htmlBody: buildEmailHtml(data),
    name: "SOS Cumulus — Formulaire",
  });

  return json({ ok: true, diag: diag.ref || null });
}

/**
 * Ask the Diag API to open a file and text the client its personal link.
 *
 * Returns an object rather than throwing: the lead is already worth handling
 * whether or not the remote diagnosis could be opened.
 */
function ouvrirDiagnostic(tel, ville, probleme) {
  var apiUrl = P.getProperty("API_URL");
  var secret = P.getProperty("LEAD_SECRET");
  if (!apiUrl || !secret) {
    console.warn("API_URL ou LEAD_SECRET absent des propriétés du script.");
    return {};
  }

  try {
    var res = UrlFetchApp.fetch(apiUrl + "/api/lead", {
      method: "post",
      contentType: "application/json",
      headers: { "x-lead-secret": secret },
      payload: JSON.stringify({
        tel: tel,
        ville: ville,
        probleme: probleme,
        source: "formulaire_site",
      }),
      muteHttpExceptions: true,
    });
    var code = res.getResponseCode();
    if (code < 200 || code >= 300) {
      console.error("API diag " + code + " " + res.getContentText());
      return {};
    }
    return JSON.parse(res.getContentText());
  } catch (err) {
    console.error("API diag injoignable : " + err);
    return {};
  }
}

/* ------------------------------------------------------------------ */
/* 2. Callbacks from the Diag API                                      */
/* ------------------------------------------------------------------ */

function handleApiCallback(e, secret) {
  if (secret !== P.getProperty("FICHE_SECRET")) {
    return json({ ok: false, error: "unauthorized" });
  }

  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json({ ok: false, error: "invalid_json" });
  }

  if (body.type === "fiche") return json(genererFiche(body));
  if (body.type === "alerte_securite") return json(alerteSecurite(body));
  return json({ ok: false, error: "unknown_type" });
}

/**
 * Fill the Docs template and archive the media next to it.
 *
 * One sub-folder per intervention: the technician opens a single place and
 * finds the file, the three photos, the control-panel frames and the video.
 */
function genererFiche(d) {
  var modele = DriveApp.getFileById(P.getProperty("TEMPLATE_ID"));
  var racine = DriveApp.getFolderById(P.getProperty("DOSSIER_ID"));

  var dossier = racine.createFolder(
    d.ref + " — " + (d.ville || "sans commune") + " — " +
      Utilities.formatDate(new Date(), "Europe/Paris", "yyyy-MM-dd")
  );
  var copie = modele.makeCopy("Fiche " + d.ref, dossier);

  var doc = DocumentApp.openById(copie.getId());
  var corps = doc.getBody();
  var diag = d.diagnostic || {};
  var plaque = plaqueDe_(d);

  var champs = {
    "{{REF}}": d.ref || "",
    "{{TEL}}": d.tel || "",
    "{{VILLE}}": d.ville || "",
    "{{PROBLEME}}": d.probleme || "",
    "{{DATE}}": Utilities.formatDate(new Date(), "Europe/Paris", "dd/MM/yyyy HH:mm"),
    "{{APPAREIL}}": [plaque.brand, plaque.model, plaque.capacityLiters ? plaque.capacityLiters + " L" : ""]
      .filter(String).join(" · ") || "Non identifié",
    "{{SYNTHESE}}": diag.summary || "",
    "{{CAUSE}}": diag.likelyCause || "",
    "{{ACTION}}": diag.recommendedAction || "",
    "{{URGENCE}}": diag.urgency || "",
    "{{PIECES}}": (diag.partsLikely || []).join(", ") || "À confirmer",
    "{{DUREE}}": diag.estimatedDurationMin ? diag.estimatedDurationMin + " min" : "À estimer",
    "{{CONFIANCE}}": diag.confidence || "",
    "{{VISITE}}": diag.needsOnSite ? "Oui" : "Non",
    "{{NOTES}}": diag.technicianNotes || "",
    "{{BANDEAU}}": bandeauTexte_(d.bandeau),
    // A Doc cannot embed a video, so this stays a link. It expires with the
    // file, at seven days — the Doc remains readable without it afterwards.
    "{{VIDEO}}": d.bandeauVideoUrl || "Aucune vidéo",
    "{{ACCES}}": (d.answers && d.answers.acces) || "",
    "{{DISPO}}": (d.answers && d.answers.dispo) || "",
  };
  for (var cle in champs) corps.replaceText(escapeRegex_(cle), champs[cle]);

  // Photos are embedded, not linked: the signed URLs expire with the file and
  // the Doc has to stay readable long after.
  var ancre = corps.findText("{{PHOTOS}}");
  if (ancre) {
    var para = ancre.getElement().getParent().asParagraph();
    para.clear();
    (d.photos || []).forEach(function (p) {
      if (!p.url) return;
      try {
        var blob = UrlFetchApp.fetch(p.url, { muteHttpExceptions: true }).getBlob();
        var img = corps.insertImage(corps.getChildIndex(para) + 1, blob);
        img.setWidth(280);
        img.setHeight((img.getHeight() / img.getWidth()) * 280);
      } catch (err) {
        console.error("photo " + p.slot + " non insérée : " + err);
      }
    });
  }

  doc.saveAndClose();
  var pdf = dossier.createFile(copie.getAs("application/pdf")).setName("Fiche " + d.ref + ".pdf");

  archiver_(dossier, d);

  return { ok: true, doc: copie.getUrl(), pdf: pdf.getUrl(), dossier: dossier.getUrl() };
}

/**
 * Copy the media from R2 into the intervention folder.
 *
 * Each file is isolated in its own try: a missing photo must not stop the
 * others, nor fail the file, which is already written by this point.
 */
function archiver_(dossier, d) {
  var aRecopier = [];

  (d.photos || []).forEach(function (p) {
    if (p.url) aRecopier.push({ url: p.url, nom: "photo-" + p.slot + ".jpg" });
  });
  (d.bandeauFrames || []).forEach(function (f) {
    aRecopier.push({ url: f.url, nom: "bandeau-" + String(f.index + 1) + ".jpg" });
  });
  if (d.bandeauVideoUrl) {
    aRecopier.push({ url: d.bandeauVideoUrl, nom: "bandeau-source.mp4" });
  }

  aRecopier.forEach(function (item) {
    try {
      var res = UrlFetchApp.fetch(item.url, { muteHttpExceptions: true });
      if (res.getResponseCode() !== 200) {
        console.error("archivage " + item.nom + " : HTTP " + res.getResponseCode());
        return;
      }
      dossier.createFile(res.getBlob().setName(item.nom));
    } catch (err) {
      // Most likely cause: a video beyond the 50 MB UrlFetchApp accepts. The
      // Worker caps uploads below that, but the guard stays useful.
      console.error("archivage " + item.nom + " impossible : " + err);
    }
  });
}

/**
 * A hazard was declared during the diagnosis: water near electrics, tripping
 * breaker, gas smell. The client's journey stopped there and someone must
 * call back now — this is both a duty of care and the hottest lead we get.
 */
function alerteSecurite(d) {
  var libelles = {
    disjoncteur: "Le disjoncteur a sauté",
    eau_electricite: "De l'eau coule près de prises ou d'appareils électriques",
    gaz: "Odeur de gaz",
  };
  var motifs = (d.flags || []).map(function (f) { return libelles[f] || f; });

  MailApp.sendEmail({
    to: RECIPIENTS.join(","),
    subject: "🚨 DANGER DÉCLARÉ — rappeler immédiatement " + (d.tel || "") + " (" + d.ref + ")",
    body:
      "Un client a déclaré une situation dangereuse pendant son diagnostic.\n\n" +
      "Dossier : " + d.ref + "\n" +
      "Téléphone : " + d.tel + "\n" +
      "Commune : " + (d.ville || "non renseignée") + "\n" +
      "Motif : " + motifs.join(" · ") + "\n\n" +
      "Le parcours a été interrompu et le client attend un appel.\n",
    htmlBody: buildAlertHtml(d, motifs),
    name: "SOS Cumulus — Alerte sécurité",
  });
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* 3. Archive retention                                                */
/* ------------------------------------------------------------------ */

/**
 * Remove intervention folders past the retention period.
 *
 * Needs a monthly time-driven trigger. Without it the duration announced to
 * the client on the welcome screen is not kept and the archive grows forever.
 *
 * setTrashed rather than a hard delete: Drive's bin keeps the folder
 * recoverable for thirty days, which covers an accidental purge, then removes
 * it on its own.
 */
function purgerArchives() {
  var ans = Number(P.getProperty("ARCHIVE_ANS") || "2");
  var limite = new Date();
  limite.setFullYear(limite.getFullYear() - ans);

  var racine = DriveApp.getFolderById(P.getProperty("DOSSIER_ID"));
  var dossiers = racine.getFolders();
  var supprimes = 0;

  while (dossiers.hasNext()) {
    var d = dossiers.next();
    if (d.getDateCreated() < limite) {
      d.setTrashed(true);
      supprimes++;
    }
  }

  if (supprimes > 0) {
    console.log("purge archive : " + supprimes + " dossier(s) au-delà de " + ans + " ans");
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function escapeRegex_(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function plaqueDe_(d) {
  var p1 = (d.photos || []).filter(function (p) { return p.slot === 1; })[0];
  return (p1 && p1.analysis && p1.analysis.nameplate) || {};
}

/** Readable rendering of the control-panel analysis for the printed file. */
function bandeauTexte_(b) {
  if (!b) return "Non renseigné";
  var lignes = [];
  if (b.code) lignes.push("Code affiché : " + b.code);
  if (b.blinkPattern) lignes.push("Séquence : " + b.blinkPattern);
  if (b.indicators && b.indicators.length) lignes.push("Voyants : " + b.indicators.join(", "));
  if (b.interpretation) lignes.push("Lecture : " + b.interpretation);
  return lignes.length ? lignes.join("\n") : "Aucun signal exploitable";
}

// Escape HTML to prevent any injection in the email.
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function emailRow_(label, value, accent) {
  return (
    '<tr>' +
      '<td style="padding:14px 0;border-bottom:1px solid ' + LINE + ';font-size:13px;color:' + GRAY + ';font-weight:600;text-transform:uppercase;letter-spacing:.04em;width:42%;vertical-align:top;">' + esc(label) + '</td>' +
      '<td style="padding:14px 0;border-bottom:1px solid ' + LINE + ';font-size:16px;color:' + (accent ? ORANGE : INK) + ';font-weight:' + (accent ? '700' : '600') + ';text-align:right;vertical-align:top;">' + value + '</td>' +
    '</tr>'
  );
}

/** Shared shell: rounded card, coloured header band, footer. */
function emailShell_(bannerText, inner) {
  return '' +
  '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>' +
  '<body style="margin:0;padding:0;background:' + OFFWHITE + ';">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:' + OFFWHITE + ';padding:24px 12px;font-family:\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;">' +
      '<tr><td align="center">' +
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 10px 30px -12px rgba(15,30,50,.22);">' +
          '<tr><td style="background:' + NAVY + ';background-image:linear-gradient(135deg,' + NAVY + ' 0%,' + NAVY_DEEP + ' 100%);padding:28px 32px;">' +
            '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>' +
              '<td><table role="presentation" cellpadding="0" cellspacing="0"><tr>' +
                  '<td style="background:#ffffff;border-radius:12px;font-size:0;line-height:0;padding:8px 12px;">' +
                    '<img src="https://soscumulus.fr/img/logo-email.png" alt="SOS Cumulus" height="36" style="display:block;border:0;outline:none;height:36px;width:auto;">' +
                  '</td>' +
              '</tr></table></td>' +
              '<td align="right" style="font-size:12px;color:' + ICE + ';font-weight:600;">' + esc(bannerText) + '</td>' +
            '</tr></table>' +
          '</td></tr>' +
          inner +
          '<tr><td style="padding:18px 32px;background:' + OFFWHITE + ';border-top:1px solid ' + LINE + ';">' +
            '<p style="margin:0;font-size:12px;color:' + GRAY + ';line-height:1.5;">Engagement&nbsp;: rappel sous 15&nbsp;minutes, intervention sous 4&nbsp;heures.<br>E-mail automatique envoyé par <a href="https://docs.google.com/spreadsheets/d/' + SHEET_ID + '/edit" style="color:' + NAVY + ';font-weight:600;text-decoration:underline;">le formulaire du site SOS Cumulus</a>.</p>' +
          '</td></tr>' +
        '</table>' +
      '</td></tr>' +
    '</table>' +
  '</body></html>';
}

/**
 * Build the HTML email in the SOS Cumulus brand colors.
 * Table-based layout + inline styles (Gmail/Outlook/Apple Mail compatible).
 */
function buildEmailHtml(d) {
  var telDigits = String(d.tel || "").replace(/[^0-9+]/g, "");
  var telCell = telDigits
    ? '<a href="tel:' + esc(telDigits) + '" style="color:' + ORANGE + ';text-decoration:none;font-weight:700;">' + esc(d.tel) + '</a>'
    : esc(d.tel);

  var inner =
    '<tr><td style="background:' + ORANGE + ';padding:14px 32px;font-size:15px;font-weight:700;color:#ffffff;">' +
      '🔔 Nouvelle demande de rappel' +
    '</td></tr>' +
    '<tr><td style="padding:28px 32px 8px;">' +
      '<p style="margin:0 0 18px;font-size:15px;color:' + INK + ';line-height:1.5;">Un client vient de demander à être rappelé via le site.<br>Voici ses informations&nbsp;:</p>' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' +
        emailRow_("Téléphone", telCell, true) +
        emailRow_("Type de problème", esc(d.probleme)) +
        emailRow_("Ville", esc(d.ville)) +
        emailRow_("Reçue le", '<span style="font-size:14px;color:' + GRAY + ';font-weight:500;">' + esc(d.receivedAt) + '</span>') +
      '</table>' +
    '</td></tr>';

  // Remote diagnosis block. Shown even when the SMS failed: the link is valid
  // either way and can be sent by hand.
  if (d.diagUrl) {
    inner +=
      '<tr><td style="padding:4px 32px 0;">' +
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:' + OFFWHITE + ';border:1px solid ' + LINE + ';border-radius:12px;">' +
          '<tr><td style="padding:16px 18px;">' +
            '<p style="margin:0 0 6px;font-size:12px;color:' + GRAY + ';font-weight:600;text-transform:uppercase;letter-spacing:.04em;">Diagnostic à distance ' + esc(d.diagRef) + '</p>' +
            '<p style="margin:0 0 10px;font-size:14px;color:' + INK + ';line-height:1.5;">' +
              (d.smsSent
                ? 'Le lien a été envoyé au client par SMS.'
                : '<strong style="color:' + RED + ';">SMS non envoyé</strong> — transmettez ce lien au client à la main.') +
            '</p>' +
            '<a href="' + esc(d.diagUrl) + '" style="font-size:13px;color:' + NAVY + ';font-weight:600;word-break:break-all;">' + esc(d.diagUrl) + '</a>' +
          '</td></tr>' +
        '</table>' +
      '</td></tr>';
  }

  if (telDigits) {
    inner +=
      '<tr><td style="padding:16px 32px 28px;" align="center">' +
        '<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:12px;background:' + ORANGE + ';">' +
          '<a href="tel:' + esc(telDigits) + '" style="display:inline-block;padding:15px 34px;font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:12px;">📞 Rappeler ce client</a>' +
        '</td></tr></table>' +
      '</td></tr>';
  } else {
    inner += '<tr><td style="padding:0 32px 20px;"></td></tr>';
  }

  return emailShell_("Demande de rappel", inner);
}

/** Hazard alert: same shell, red band, and the reasons spelled out. */
function buildAlertHtml(d, motifs) {
  var telDigits = String(d.tel || "").replace(/[^0-9+]/g, "");
  var liste = motifs.map(function (m) {
    return '<li style="margin:0 0 6px;font-size:15px;color:' + INK + ';">' + esc(m) + '</li>';
  }).join("");

  var inner =
    '<tr><td style="background:' + RED + ';padding:14px 32px;font-size:15px;font-weight:700;color:#ffffff;">' +
      '🚨 Danger déclaré — rappeler immédiatement' +
    '</td></tr>' +
    '<tr><td style="padding:28px 32px 8px;">' +
      '<p style="margin:0 0 14px;font-size:15px;color:' + INK + ';line-height:1.5;">Un client a déclaré une situation dangereuse pendant son diagnostic. Son parcours a été interrompu et il attend un appel.</p>' +
      '<ul style="margin:0 0 18px;padding-left:20px;">' + liste + '</ul>' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' +
        emailRow_("Téléphone", telDigits
          ? '<a href="tel:' + esc(telDigits) + '" style="color:' + RED + ';text-decoration:none;font-weight:700;">' + esc(d.tel) + '</a>'
          : esc(d.tel), false) +
        emailRow_("Commune", esc(d.ville || "non renseignée")) +
        emailRow_("Dossier", esc(d.ref)) +
      '</table>' +
    '</td></tr>' +
    (telDigits ?
    '<tr><td style="padding:16px 32px 28px;" align="center">' +
      '<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:12px;background:' + RED + ';">' +
        '<a href="tel:' + esc(telDigits) + '" style="display:inline-block;padding:15px 34px;font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:12px;">📞 Appeler maintenant</a>' +
      '</td></tr></table>' +
    '</td></tr>' : '');

  return emailShell_("Alerte sécurité", inner);
}

/* ------------------------------------------------------------------ */
/* One-off setup                                                       */
/* ------------------------------------------------------------------ */

/**
 * RUN ONCE (Apps Script editor → select "setupStatusColumn" → Run):
 *   - adds a status dropdown to column F
 *   - applies per-status colors (conditional formatting), with a gradient
 *   - labels column G, which now holds the remote-diagnosis link
 * Idempotent: re-running rewrites the rules cleanly.
 */
function setupStatusColumn() {
  var sh = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
  var range = sh.getRange("F2:F2000");
  var labels = STATUSES.map(function (s) { return s.label; });

  // Column headers
  sh.getRange("F1").setValue("Statut");
  sh.getRange("G1").setValue("Diagnostic à distance");

  // Dropdown
  var dv = SpreadsheetApp.newDataValidation()
    .requireValueInList(labels, true)
    .setAllowInvalid(true)
    .build();
  range.setDataValidation(dv);

  // Per-status colors (replaces all existing rules on the sheet)
  var rules = STATUSES.map(function (s) {
    return SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(s.label)
      .setBackground(s.bg)
      .setFontColor(s.fg)
      .setRanges([range])
      .build();
  });
  sh.setConditionalFormatRules(rules);
}
