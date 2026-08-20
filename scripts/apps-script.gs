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
 *        REPORT_SECRET  same value as the Worker secret
 *        TEMPLATE_ID   id of the Google Docs template
 *        ARCHIVE_FOLDER_ID    id of the Drive folder holding intervention files
 *        ARCHIVE_YEARS   2
 *      Then run `setupStatusColumn` once: it names columns F to H and puts the
 *      spreadsheet on Europe/Paris. Column H is filled later, when the
 *      intervention file lands in Drive.
 *   4. Deploy → New deployment → type "Web app".
 *        - Execute as: Me
 *        - Who has access: Anyone
 *      → Authorize the requested Google scopes, copy the "/exec" URL.
 *   5. Use that URL in the website (SITE.formEndpoint) AND in the Worker's
 *      REPORT_WEBHOOK_URL variable (api/wrangler.toml).
 *   6. Triggers → Add trigger → purgeArchives → Time-driven → Month timer.
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

// Enumerations travel in English — they are identifiers. This file is where
// they meet a human: a technician reading "within_24h" on an intervention
// sheet is a technician reading a bug.
var LABELS = {
  // Exactement les valeurs de Diagnosis.urgency dans shared/types.ts. Une clé
  // inventée ne casse rien : elle imprime « schedulable » sur l'ordre
  // d'intervention et personne ne le voit avant le technicien.
  urgency: {
    immediate: "Immédiate",
    within_24h: "Sous 24 h",
    within_72h: "Sous 72 h",
    schedulable: "À planifier",
  },
  confidence: { low: "Faible", medium: "Moyenne", high: "Élevée" },
  occupancy: { owner: "Propriétaire", tenant: "Locataire", manager: "Gestionnaire" },
  access: {
    easy: "Facile d'accès",
    cupboard: "Placard ou coffrage",
    hatch: "Faux plafond ou trappe",
    basement: "Cave ou sous-sol",
  },
};

// Caption under each photo in the report: the very title the client read while
// taking it. Duplicated from web/src/questions.ts PHOTO_SCREENS — the wording
// is short, stable, and shipping it through the API would mean a Worker deploy
// for a caption change.
var PHOTO_TITLES = {
  1: "L'étiquette du chauffe-eau",
  2: "Le chauffe-eau en entier",
  3: "Là où ça coule",
};

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
  var diag = openDiagnosisCase(tel, ville, probleme);

  // 1) Write to the Sheet (first tab) — column F = default status
  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
  sheet.appendRow([now, tel, probleme, ville, page, DEFAULT_STATUS, diag.url || ""]);
  // Force column B (phone) to text so the leading 0 is kept (06…, 04…).
  var lastRow = sheet.getLastRow();
  sheet.getRange(lastRow, 2).setNumberFormat("@").setValue(tel);

  // 2) Email to recipients (HTML in the site's colors + plain-text fallback)
  var receivedAt = Utilities.formatDate(now, "Europe/Paris", "dd/MM/yyyy 'à' HH:mm");
  // Same names as everywhere else — buildEmailHtml reads `phone`, `city` and
  // `reportedIssue`. Handing it `tel`/`ville`/`probleme` printed four empty
  // rows, and the fallbacks below never showed because the keys never matched.
  var data = {
    phone: tel,
    reportedIssue: probleme || "Non précisé",
    city: ville || "Non précisée",
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
    "Type de problème : " + data.reportedIssue + "\n" +
    "Ville : " + data.city + "\n" +
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
function openDiagnosisCase(tel, ville, probleme) {
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
      // Keys are the API contract (shared/types.ts LeadRequest), not the form's
      // French field names: `phone`, not `tel`. Sending the form's names got a
      // 400 on every submission, silently — the lead was emailed and no
      // diagnosis file was ever opened.
      payload: JSON.stringify({
        phone: tel,
        city: ville,
        reportedIssue: probleme,
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
  if (secret !== P.getProperty("REPORT_SECRET")) {
    return json({ ok: false, error: "unauthorized" });
  }

  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json({ ok: false, error: "invalid_json" });
  }

  if (body.type === "report") return json(buildReport(body));
  if (body.type === "safety_alert") return json(sendSafetyAlert(body));
  return json({ ok: false, error: "unknown_type" });
}

/**
 * Fill the Docs template and archive the media next to it.
 *
 * One sub-folder per intervention: the technician opens a single place and
 * finds the file, the three photos, the control-panel frames and the video.
 */
function buildReport(d) {
  var template = DriveApp.getFileById(P.getProperty("TEMPLATE_ID"));
  var archiveRoot = DriveApp.getFolderById(P.getProperty("ARCHIVE_FOLDER_ID"));

  var folder = archiveRoot.createFolder(
    d.ref + " — " + (d.city || "sans commune") + " — " +
      Utilities.formatDate(new Date(), "Europe/Paris", "yyyy-MM-dd")
  );
  var docCopy = template.makeCopy("Fiche " + d.ref, folder);

  var doc = DocumentApp.openById(docCopy.getId());
  var body = doc.getBody();
  var diag = d.diagnosis || {};
  var nameplate = nameplateOf_(d);

  var fields = {
    "{{REF}}": d.ref || "",
    "{{NOM}}": [(d.answers || {}).firstName, (d.answers || {}).lastName]
      .filter(filled_).join(" ").trim(),
    "{{ADRESSE}}": (d.answers || {}).address || d.city || "",
    "{{TEL}}": d.phone || "",
    "{{VILLE}}": d.city || "",
    "{{PROBLEME}}": d.reportedIssue || "",
    "{{DATE}}": Utilities.formatDate(new Date(), "Europe/Paris", "dd/MM/yyyy HH:mm"),
    "{{APPAREIL}}": [nameplate.brand, nameplate.model, nameplate.capacityLiters ? nameplate.capacityLiters + " L" : ""]
      .filter(filled_).join(" · ") || "Non identifié",
    "{{SYNTHESE}}": diag.summary || "",
    "{{CAUSE}}": diag.likelyCause || "",
    "{{ACTION}}": diag.recommendedAction || "",
    "{{URGENCE}}": LABELS.urgency[diag.urgency] || diag.urgency || "",
    "{{PIECES}}": (diag.partsLikely || []).join(", ") || "À confirmer",
    "{{DUREE}}": diag.estimatedDurationMin ? diag.estimatedDurationMin + " min" : "À estimer",
    "{{CONFIANCE}}": LABELS.confidence[diag.confidence] || diag.confidence || "",
    "{{VISITE}}": diag.needsOnSite ? "Oui" : "Non",
    "{{NOTES}}": diag.technicianNotes || "",
    "{{PLAQUE}}": nameplateSummary_(nameplate),
    "{{BANDEAU}}": panelSummary_(d.panel),
    // Fine-grained nameplate fields: the paper form has a box per marking.
    "{{MARQUE}}": nameplate.brand || "",
    "{{MODELE}}": nameplate.model || "",
    "{{CAPACITE}}": nameplate.capacityLiters ? nameplate.capacityLiters + " L" : "",
    "{{SERIE}}": [nameplate.serial, nameplate.manufactureCode, nameplate.manufactureDate]
      .filter(filled_).join(" · "),
    "{{OCCUPANT}}": LABELS.occupancy[(d.answers || {}).occupancy] || "",
    "{{ECRAN}}": (d.answers || {}).hasPanel === "yes" ? "Oui"
      : (d.answers || {}).hasPanel === "no" ? "Non" : "",
    // A Doc cannot embed a video, so this stays a link. It expires with the
    // file, at seven days — the Doc remains readable without it afterwards.
    "{{VIDEO}}": d.panelVideoUrl || "Aucune vidéo",
    "{{ACCES}}": LABELS.access[(d.answers || {}).access] || "",
    "{{DISPO}}": availabilityText_(d.answers && d.answers.availability),
  };
  for (var key in fields) body.replaceText(escapeRegex_(key), fields[key]);

  // Photos are embedded, not linked: the signed URLs expire with the file and
  // the Doc has to stay readable long after.
  var anchor = body.findText("{{PHOTOS}}");
  if (anchor) {
    var para = anchor.getElement().getParent().asParagraph();
    para.clear();
    // Inserted bottom-up at a fixed index, so slot 1 ends up first: each
    // insertion pushes the previous one down.
    var slots = (d.photos || []).slice().sort(function (a, b) { return b.slot - a.slot; });
    var index = body.getChildIndex(para) + 1;
    slots.forEach(function (p) {
      var title = PHOTO_TITLES[p.slot] || ("Photo " + p.slot);
      if (!p.url) {
        var absent = body.insertParagraph(index, title + " — " +
          (p.skipped ? "passée par le client" : "non transmise"));
        absent.setForegroundColor(GRAY).setFontSize(9);
        return;
      }
      try {
        var blob = UrlFetchApp.fetch(p.url, { muteHttpExceptions: true }).getBlob();
        var img = body.insertImage(index, blob);
        img.setWidth(320);
        img.setHeight((img.getHeight() / img.getWidth()) * 320);
        // The caption goes above the image: inserted at the same index, it is
        // pushed down and lands on top of it.
        var caption = body.insertParagraph(index, title);
        caption.setForegroundColor(NAVY).setFontSize(10).setBold(true);
      } catch (err) {
        console.error("photo " + p.slot + " non insérée : " + err);
      }
    });
  }

  // QR and clickable link to the durable archive. The R2 links expire in seven
  // days; this folder is what still answers in two years.
  var qrAnchor = body.findText("{{QR}}");
  if (qrAnchor) {
    var qrPara = qrAnchor.getElement().getParent().asParagraph();
    qrPara.clear();
    try {
      var bytes = qrPng(qrMatrix(folder.getUrl()), 6, 3);
      var qrImg = qrPara.appendInlineImage(
        Utilities.newBlob(bytes, "image/png", "qr.png"));
      qrImg.setWidth(96);
      qrImg.setHeight(96);
    } catch (err) {
      console.error("QR non genere : " + err);
      qrPara.appendText("");
    }
  }

  var mediaAnchor = body.findText("{{MEDIA}}");
  if (mediaAnchor) {
    var mediaPara = mediaAnchor.getElement().getParent().asParagraph();
    mediaPara.clear();
    mediaPara.appendText("Ouvrir le dossier").setLinkUrl(folder.getUrl());
  }

  doc.saveAndClose();
  var pdf = folder.createFile(docCopy.getAs("application/pdf")).setName("Fiche " + d.ref + ".pdf");

  archiveMedia_(folder, d);

  var urls = { doc: docCopy.getUrl(), pdf: pdf.getUrl(), folder: folder.getUrl() };
  linkArchiveInSheet_(d.caseUrl, urls.folder);
  sendReportEmail_(d, urls);

  return { ok: true, doc: urls.doc, pdf: urls.pdf, folder: urls.folder };
}

/**
 * Write the archive folder back onto the lead's row, column H.
 *
 * The row is found by the client link in column G: it carries the case token,
 * and it is the only value on that row that identifies the file without
 * ambiguity — two calls from the same number on the same day are ordinary.
 * Scanned from the bottom, the recent rows being the ones we want.
 */
function linkArchiveInSheet_(caseUrl, folderUrl) {
  if (!caseUrl) return;
  try {
    var sh = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
    var last = sh.getLastRow();
    if (last < 2) return;
    var links = sh.getRange(2, 7, last - 1, 1).getValues();
    for (var i = links.length - 1; i >= 0; i--) {
      if (String(links[i][0]).trim() === String(caseUrl).trim()) {
        sh.getRange(i + 2, 8).setValue(folderUrl);
        return;
      }
    }
    console.warn("Ligne introuvable dans le suivi pour " + caseUrl);
  } catch (err) {
    // The file exists in Drive; a missing back-link must not fail the report.
    console.error("lien dossier non ecrit : " + err);
  }
}

/**
 * Tell the team the diagnosis is ready.
 *
 * The synthesis runs after the client has left — thirty seconds to three
 * minutes later — so this is the only signal that the file is complete. Without
 * it the sheet fills up with diagnoses nobody knows to go and read.
 *
 * Written to be decided on without opening anything: reference, commune,
 * urgency and likely cause, then the links.
 */
function sendReportEmail_(d, urls) {
  try {
    var diag = d.diagnosis || {};
    var nameplate = nameplateOf_(d);
    var urgency = LABELS.urgency[diag.urgency] || diag.urgency || "à évaluer";
    var appliance = [nameplate.brand, nameplate.model,
                     nameplate.capacityLiters ? nameplate.capacityLiters + " L" : ""]
      .filter(filled_).join(" · ") || "non identifié";

    var inner =
      '<tr><td style="background:' + ORANGE + ';padding:14px 32px;font-size:15px;font-weight:700;color:#ffffff;">' +
        '📋 Diagnostic prêt — ' + esc(d.ref) +
      '</td></tr>' +
      '<tr><td style="padding:28px 32px 8px;">' +
        '<p style="margin:0 0 18px;font-size:15px;color:' + INK + ';line-height:1.5;">' +
          esc(diag.summary || "Le diagnostic n'a pas pu être rédigé — les photos et les réponses sont au dossier.") +
        '</p>' +
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' +
          emailRow_("Urgence", esc(urgency), true) +
          emailRow_("Client", esc(who_(d) || "non renseigné")) +
          emailRow_("Adresse", esc((d.answers || {}).address || d.city || "non renseignée")) +
          emailRow_("Téléphone", esc(d.phone || "")) +
          emailRow_("Appareil", esc(appliance)) +
          emailRow_("Cause probable", esc(diag.likelyCause || "à confirmer sur place")) +
          emailRow_("Pièces à prévoir", esc((diag.partsLikely || []).join(", ") || "à confirmer")) +
        '</table>' +
      '</td></tr>' +
      '<tr><td style="padding:14px 32px 28px;">' +
        '<a href="' + esc(urls.pdf) + '" style="display:inline-block;padding:14px 30px;background:' + NAVY + ';font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:12px;">Ouvrir la fiche d\'intervention</a>' +
        '<p style="margin:14px 0 0;font-size:13px;color:' + GRAY + ';">' +
          '<a href="' + esc(urls.folder) + '" style="color:' + NAVY + ';">Dossier complet (photos, document modifiable)</a>' +
        '</p>' +
      '</td></tr>';

    MailApp.sendEmail({
      to: RECIPIENTS.join(","),
      subject: "📋 Diagnostic prêt — " + d.ref + " — " + (who_(d) || d.city || "client") +
               " — urgence " + urgency.toLowerCase(),
      body:
        "Diagnostic à distance terminé.\n\n" +
        "Dossier : " + d.ref + "\n" +
        "Client : " + (who_(d) || "non renseigné") + "\n" +
        "Adresse : " + ((d.answers || {}).address || d.city || "non renseignée") + "\n" +
        "Téléphone : " + (d.phone || "") + "\n" +
        "Urgence : " + urgency + "\n" +
        "Appareil : " + appliance + "\n" +
        "Cause probable : " + (diag.likelyCause || "à confirmer sur place") + "\n\n" +
        "Fiche : " + urls.pdf + "\n" +
        "Dossier : " + urls.folder + "\n",
      htmlBody: emailShell_("Diagnostic à distance", inner),
      name: "SOS Cumulus — Diagnostic",
    });
  } catch (err) {
    // The file is in Drive either way; a mail failure must not fail the report.
    console.error("e-mail de fiche non envoye : " + err);
  }
}

/**
 * Copy the media from R2 into the intervention folder.
 *
 * Each file is isolated in its own try: a missing photo must not stop the
 * others, nor fail the file, which is already written by this point.
 */
function archiveMedia_(folder, d) {
  var toCopy = [];

  (d.photos || []).forEach(function (p) {
    if (p.url) toCopy.push({ url: p.url, name: "photo-" + p.slot + ".jpg" });
  });
  (d.panelFrames || []).forEach(function (f) {
    toCopy.push({ url: f.url, name: "bandeau-" + String(f.index + 1) + ".jpg" });
  });
  if (d.panelVideoUrl) {
    toCopy.push({ url: d.panelVideoUrl, name: "bandeau-source.mp4" });
  }

  toCopy.forEach(function (item) {
    try {
      var res = UrlFetchApp.fetch(item.url, { muteHttpExceptions: true });
      if (res.getResponseCode() !== 200) {
        console.error("archivage " + item.name + " : HTTP " + res.getResponseCode());
        return;
      }
      folder.createFile(res.getBlob().setName(item.name));
    } catch (err) {
      // Most likely cause: a video beyond the 50 MB UrlFetchApp accepts. The
      // Worker caps uploads below that, but the guard stays useful.
      console.error("archivage " + item.name + " impossible : " + err);
    }
  });
}

/**
 * A hazard was declared during the diagnosis: water near electrics, tripping
 * breaker, gas smell. The client's journey stopped there and someone must
 * call back now — this is both a duty of care and the hottest lead we get.
 */
function sendSafetyAlert(d) {
  // Keys match the SafetyFlag values in shared/types.ts.
  var labels = {
    breaker_tripped: "Le disjoncteur a sauté",
    water_near_electrics: "De l'eau coule près de prises ou d'appareils électriques",
  };
  var reasons = (d.flags || []).map(function (f) { return labels[f] || f; });

  MailApp.sendEmail({
    to: RECIPIENTS.join(","),
    subject: "🚨 DANGER DÉCLARÉ — rappeler immédiatement " + (d.phone || "") + " (" + d.ref + ")",
    body:
      "Un client a déclaré une situation dangereuse pendant son diagnostic.\n\n" +
      "Dossier : " + d.ref + "\n" +
      "Téléphone : " + d.phone + "\n" +
      "Commune : " + (d.city || "non renseignée") + "\n" +
      "Motif : " + reasons.join(" · ") + "\n\n" +
      "Le parcours a été interrompu et le client attend un appel.\n",
    htmlBody: buildSafetyAlertHtml(d, reasons),
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
function purgeArchives() {
  var years = Number(P.getProperty("ARCHIVE_YEARS") || "2");
  var cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - years);

  var archiveRoot = DriveApp.getFolderById(P.getProperty("ARCHIVE_FOLDER_ID"));
  var folders = archiveRoot.getFolders();
  var removed = 0;

  while (folders.hasNext()) {
    var d = folders.next();
    if (d.getDateCreated() < cutoff) {
      d.setTrashed(true);
      removed++;
    }
  }

  if (removed > 0) {
    console.log("archive purge: " + removed + " folder(s) past " + years + " years");
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

/** First and last name as one string, empty when neither was given. */
function who_(d) {
  var a = d.answers || {};
  return [a.firstName, a.lastName].filter(filled_).join(" ").trim();
}

/**
 * Prédicat de filtrage : écarte null, undefined et la chaîne vide.
 *
 * `.filter(String)` les gardait — `String(null)` vaut "null", qui est vrai — et
 * seul `join` les effaçait ensuite, en laissant les séparateurs derrière eux.
 * D'où le « · » solitaire sur la ligne du numéro de série.
 */
function filled_(v) {
  return v !== null && v !== undefined && v !== "";
}

function nameplateOf_(d) {
  var p1 = (d.photos || []).filter(function (p) { return p.slot === 1; })[0];
  return (p1 && p1.analysis && p1.analysis.nameplate) || {};
}

/**
 * Reachability slots. Several may be given — the client is asked for every
 * moment that suits, not the best one.
 */
function availabilityText_(slots) {
  if (!slots || !slots.length) return "Dès que possible";
  var labels = {
    morning: "le matin",
    midday: "vers midi",
    afternoon: "l'après-midi",
    evening: "en fin de journée",
  };
  var text = slots.map(function (s) { return labels[s] || s; }).join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Everything read off the nameplate, one marking per line.
 *
 * {{APPAREIL}} carries the identity in one line for the header; this block is
 * what the technician actually orders parts against — the barcode identifies
 * the exact unit, the lining says whether an anode is due, and the voltage says
 * whether the existing line can even take the replacement.
 */
function nameplateSummary_(n) {
  if (!n || !n.readable) return "Étiquette non lue";
  var lines = [];
  var add = function (label, value) {
    if (value || value === 0) lines.push(label + " : " + value);
  };
  add("Marque", n.brand);
  add("Référence", n.model);
  add("Capacité", n.capacityLiters ? n.capacityLiters + " L" : "");
  add("Puissance", n.powerWatts ? n.powerWatts + " W" : "");
  add("Alimentation", n.voltage);
  add("Pression max", n.pressureBar ? String(n.pressureBar).replace(".", ",") + " bar" : "");
  add("Temps de chauffe", n.heatUpTime);
  add("Cuve", n.tankLining);
  add("Indice de protection", n.protectionIndex);
  add("Code de fabrication", n.manufactureCode);
  add("Fabrication", n.manufactureDate);
  add("N° de série", n.serial);
  add("Code-barres", n.barcode);
  return lines.length ? lines.join("\n") : "Aucune mention lisible";
}

/** Readable rendering of the control-panel analysis for the printed file. */
function panelSummary_(b) {
  if (!b) return "Non renseigné";
  var lines = [];
  if (b.code) lines.push("Code affiché : " + b.code);
  if (b.blinkPattern) lines.push("Séquence : " + b.blinkPattern);
  if (b.indicators && b.indicators.length) lines.push("Voyants : " + b.indicators.join(", "));
  if (b.interpretation) lines.push("Lecture : " + b.interpretation);
  return lines.length ? lines.join("\n") : "Aucun signal exploitable";
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
  var telDigits = String(d.phone || "").replace(/[^0-9+]/g, "");
  var telCell = telDigits
    ? '<a href="tel:' + esc(telDigits) + '" style="color:' + ORANGE + ';text-decoration:none;font-weight:700;">' + esc(d.phone) + '</a>'
    : esc(d.phone);

  var inner =
    '<tr><td style="background:' + ORANGE + ';padding:14px 32px;font-size:15px;font-weight:700;color:#ffffff;">' +
      '🔔 Nouvelle demande de rappel' +
    '</td></tr>' +
    '<tr><td style="padding:28px 32px 8px;">' +
      '<p style="margin:0 0 18px;font-size:15px;color:' + INK + ';line-height:1.5;">Un client vient de demander à être rappelé via le site.<br>Voici ses informations&nbsp;:</p>' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' +
        emailRow_("Téléphone", telCell, true) +
        emailRow_("Type de problème", esc(d.reportedIssue)) +
        emailRow_("Ville", esc(d.city)) +
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
function buildSafetyAlertHtml(d, reasons) {
  var telDigits = String(d.phone || "").replace(/[^0-9+]/g, "");
  var items = reasons.map(function (m) {
    return '<li style="margin:0 0 6px;font-size:15px;color:' + INK + ';">' + esc(m) + '</li>';
  }).join("");

  var inner =
    '<tr><td style="background:' + RED + ';padding:14px 32px;font-size:15px;font-weight:700;color:#ffffff;">' +
      '🚨 Danger déclaré — rappeler immédiatement' +
    '</td></tr>' +
    '<tr><td style="padding:28px 32px 8px;">' +
      '<p style="margin:0 0 14px;font-size:15px;color:' + INK + ';line-height:1.5;">Un client a déclaré une situation dangereuse pendant son diagnostic. Son parcours a été interrompu et il attend un appel.</p>' +
      '<ul style="margin:0 0 18px;padding-left:20px;">' + items + '</ul>' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' +
        emailRow_("Téléphone", telDigits
          ? '<a href="tel:' + esc(telDigits) + '" style="color:' + RED + ';text-decoration:none;font-weight:700;">' + esc(d.phone) + '</a>'
          : esc(d.phone), false) +
        emailRow_("Commune", esc(d.city || "non renseignée")) +
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
  var ss = SpreadsheetApp.openById(SHEET_ID);

  // Dates are written as real Date values so the column stays sortable, and a
  // Sheet renders them in its own timezone — not the script's. Left on the
  // account default (America/Los_Angeles) every timestamp read nine hours
  // early. Formatting to a string here would have fixed the display and broken
  // the sort.
  if (ss.getSpreadsheetTimeZone() !== "Europe/Paris") {
    ss.setSpreadsheetTimeZone("Europe/Paris");
  }

  var sh = ss.getSheets()[0];
  var range = sh.getRange("F2:F2000");
  var labels = STATUSES.map(function (s) { return s.label; });

  // Column headers
  sh.getRange("F1").setValue("Statut");
  sh.getRange("G1").setValue("Diagnostic à distance");
  sh.getRange("H1").setValue("Dossier d'intervention");

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

/* ------------------------------------------------------------------ */
/* QR code                                                             */
/* ------------------------------------------------------------------ */

/**
 * Minimal QR encoder — byte mode, error correction level M, versions 1 to 10.
 *
 * Written rather than fetched: the Google Charts endpoint that used to serve
 * these has been switched off, and handing a link to a client's home photos to
 * a third-party image service would have it logged there. Ten versions cover
 * 213 bytes, far more than a Drive folder URL ever needs.
 *
 * Returns a square array of booleans, true meaning a dark module.
 */
function qrMatrix(text) {
  var CAPACITY = [0, 14, 26, 42, 62, 84, 106, 122, 152, 180, 213];
  // [total codewords, ec per block, group1 blocks, group1 data, group2 blocks, group2 data]
  var BLOCKS = [
    null,
    [26, 10, 1, 16, 0, 0],
    [44, 16, 1, 28, 0, 0],
    [70, 26, 1, 44, 0, 0],
    [100, 18, 2, 32, 0, 0],
    [134, 24, 2, 43, 0, 0],
    [172, 16, 4, 27, 0, 0],
    [196, 18, 4, 31, 0, 0],
    [242, 22, 2, 38, 2, 39],
    [292, 22, 3, 36, 2, 37],
    [346, 26, 4, 43, 1, 44],
  ];
  var ALIGN = [
    [], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
    [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
  ];
  var FORMAT_M = [
    0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0,
  ];
  var VERSION_INFO = {
    7: 0x07c94, 8: 0x085bc, 9: 0x09a99, 10: 0x0a4d3,
  };

  /* ---- bytes (UTF-8) ---- */
  var data = [];
  for (var i = 0; i < text.length; i++) {
    var c = text.charCodeAt(i);
    if (c < 0x80) data.push(c);
    else if (c < 0x800) data.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else data.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }

  var version = 0;
  for (var v = 1; v <= 10; v++) {
    if (data.length <= CAPACITY[v]) { version = v; break; }
  }
  if (!version) throw new Error('QR: texte trop long');

  var spec = BLOCKS[version];
  var totalCw = spec[0], ecPerBlock = spec[1];
  var g1 = spec[2], d1 = spec[3], g2 = spec[4], d2 = spec[5];
  var dataCw = g1 * d1 + g2 * d2;

  /* ---- bit stream ---- */
  var bits = [];
  function put(value, length) {
    for (var b = length - 1; b >= 0; b--) bits.push((value >> b) & 1);
  }
  put(4, 4);                                   // byte mode
  put(data.length, version < 10 ? 8 : 16);     // character count
  for (var j = 0; j < data.length; j++) put(data[j], 8);

  var capacityBits = dataCw * 8;
  for (var t = 0; t < 4 && bits.length < capacityBits; t++) bits.push(0);
  while (bits.length % 8) bits.push(0);

  var cw = [];
  for (var k = 0; k < bits.length; k += 8) {
    var byte = 0;
    for (var m = 0; m < 8; m++) byte = (byte << 1) | bits[k + m];
    cw.push(byte);
  }
  var pad = [0xec, 0x11], p = 0;
  while (cw.length < dataCw) cw.push(pad[p++ % 2]);

  /* ---- Reed-Solomon over GF(256) ---- */
  var EXP = new Array(512), LOG = new Array(256);
  for (var x = 0, e = 1; x < 255; x++) {
    EXP[x] = e; LOG[e] = x;
    e <<= 1;
    if (e & 0x100) e ^= 0x11d;
  }
  for (var y = 255; y < 512; y++) EXP[y] = EXP[y - 255];

  function generator(degree) {
    var poly = [1];
    for (var d = 0; d < degree; d++) {
      var next = poly.concat([0]);
      for (var q = 0; q < poly.length; q++) {
        next[q + 1] ^= poly[q] ? EXP[(LOG[poly[q]] + d) % 255] : 0;
      }
      poly = next;
    }
    return poly;
  }

  function ecFor(block, count) {
    var gen = generator(count);
    var rem = block.concat(new Array(count).fill(0));
    for (var s = 0; s < block.length; s++) {
      var lead = rem[s];
      if (!lead) continue;
      for (var g = 0; g < gen.length; g++) {
        rem[s + g] ^= gen[g] ? EXP[(LOG[gen[g]] + LOG[lead]) % 255] : 0;
      }
    }
    return rem.slice(block.length);
  }

  var blocks = [], ecs = [], at = 0;
  for (var b1 = 0; b1 < g1; b1++) { blocks.push(cw.slice(at, at + d1)); at += d1; }
  for (var b2 = 0; b2 < g2; b2++) { blocks.push(cw.slice(at, at + d2)); at += d2; }
  for (var bb = 0; bb < blocks.length; bb++) ecs.push(ecFor(blocks[bb], ecPerBlock));

  // Interleaved, as the specification requires: a scratch on the paper then
  // damages a few modules of every block rather than destroying one entirely.
  var final = [];
  var maxData = Math.max(d1, d2 || 0);
  for (var col = 0; col < maxData; col++) {
    for (var bl = 0; bl < blocks.length; bl++) {
      if (col < blocks[bl].length) final.push(blocks[bl][col]);
    }
  }
  for (var ecol = 0; ecol < ecPerBlock; ecol++) {
    for (var eb = 0; eb < ecs.length; eb++) final.push(ecs[eb][ecol]);
  }
  if (final.length !== totalCw) throw new Error('QR: assemblage incoherent');

  /* ---- matrix ---- */
  var size = 17 + version * 4;
  var mod = [], reserved = [];
  for (var r = 0; r < size; r++) {
    mod.push(new Array(size).fill(false));
    reserved.push(new Array(size).fill(false));
  }
  function set(rr, cc, dark) { mod[rr][cc] = dark; reserved[rr][cc] = true; }

  function finder(rr, cc) {
    for (var dr = -1; dr <= 7; dr++) {
      for (var dc = -1; dc <= 7; dc++) {
        var r2 = rr + dr, c2 = cc + dc;
        if (r2 < 0 || c2 < 0 || r2 >= size || c2 >= size) continue;
        var inRing = (dr >= 0 && dr <= 6 && (dc === 0 || dc === 6)) ||
                     (dc >= 0 && dc <= 6 && (dr === 0 || dr === 6));
        var inCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        set(r2, c2, inRing || inCore);
      }
    }
  }
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

  for (var tm = 8; tm < size - 8; tm++) {
    set(6, tm, tm % 2 === 0);
    set(tm, 6, tm % 2 === 0);
  }

  var centres = ALIGN[version];
  for (var ai = 0; ai < centres.length; ai++) {
    for (var aj = 0; aj < centres.length; aj++) {
      var ar = centres[ai], ac = centres[aj];
      if ((ar === 6 && ac === 6) || (ar === 6 && ac === size - 7) ||
          (ar === size - 7 && ac === 6)) continue;
      for (var dr2 = -2; dr2 <= 2; dr2++) {
        for (var dc2 = -2; dc2 <= 2; dc2++) {
          var ring = Math.max(Math.abs(dr2), Math.abs(dc2));
          set(ar + dr2, ac + dc2, ring !== 1);
        }
      }
    }
  }

  set(size - 8, 8, true);  // dark module

  // Reserve the format areas before laying data down.
  for (var f = 0; f < 9; f++) {
    if (!reserved[8][f]) reserved[8][f] = true;
    if (!reserved[f][8]) reserved[f][8] = true;
  }
  for (var f2 = 0; f2 < 8; f2++) {
    reserved[8][size - 1 - f2] = true;
    reserved[size - 1 - f2][8] = true;
  }
  if (version >= 7) {
    for (var vi = 0; vi < 18; vi++) {
      reserved[Math.floor(vi / 3)][size - 11 + (vi % 3)] = true;
      reserved[size - 11 + (vi % 3)][Math.floor(vi / 3)] = true;
    }
  }

  /* ---- data placement, upward-then-downward zigzag ---- */
  var bitIndex = 0, total = final.length * 8;
  function nextBit() {
    if (bitIndex >= total) return 0;
    var byteAt = final[bitIndex >> 3];
    var bit = (byteAt >> (7 - (bitIndex & 7))) & 1;
    bitIndex++;
    return bit;
  }
  var up = true;
  for (var colPair = size - 1; colPair > 0; colPair -= 2) {
    if (colPair === 6) colPair--;  // the vertical timing column is skipped
    for (var step = 0; step < size; step++) {
      var row = up ? size - 1 - step : step;
      for (var side = 0; side < 2; side++) {
        var c3 = colPair - side;
        if (reserved[row][c3]) continue;
        mod[row][c3] = nextBit() === 1;
      }
    }
    up = !up;
  }

  /* ---- masking ---- */
  function maskAt(pattern, r3, c4) {
    switch (pattern) {
      case 0: return (r3 + c4) % 2 === 0;
      case 1: return r3 % 2 === 0;
      case 2: return c4 % 3 === 0;
      case 3: return (r3 + c4) % 3 === 0;
      case 4: return (Math.floor(r3 / 2) + Math.floor(c4 / 3)) % 2 === 0;
      case 5: return ((r3 * c4) % 2) + ((r3 * c4) % 3) === 0;
      case 6: return (((r3 * c4) % 2) + ((r3 * c4) % 3)) % 2 === 0;
      default: return (((r3 + c4) % 2) + ((r3 * c4) % 3)) % 2 === 0;
    }
  }

  function penalty(grid) {
    var score = 0, n = size, i2, j2, run, dark = 0;
    for (i2 = 0; i2 < n; i2++) {
      run = 1;
      for (j2 = 1; j2 < n; j2++) {
        if (grid[i2][j2] === grid[i2][j2 - 1]) run++;
        else { if (run >= 5) score += run - 2; run = 1; }
      }
      if (run >= 5) score += run - 2;
      run = 1;
      for (j2 = 1; j2 < n; j2++) {
        if (grid[j2][i2] === grid[j2 - 1][i2]) run++;
        else { if (run >= 5) score += run - 2; run = 1; }
      }
      if (run >= 5) score += run - 2;
    }
    for (i2 = 0; i2 < n - 1; i2++) {
      for (j2 = 0; j2 < n - 1; j2++) {
        var a = grid[i2][j2];
        if (a === grid[i2][j2 + 1] && a === grid[i2 + 1][j2] && a === grid[i2 + 1][j2 + 1]) score += 3;
      }
    }
    var pat1 = [true, false, true, true, true, false, true, false, false, false, false];
    var pat2 = [false, false, false, false, true, false, true, true, true, false, true];
    function matches(list, start, pattern) {
      for (var q2 = 0; q2 < 11; q2++) if (list[start + q2] !== pattern[q2]) return false;
      return true;
    }
    for (i2 = 0; i2 < n; i2++) {
      var rowArr = grid[i2], colArr = [];
      for (j2 = 0; j2 < n; j2++) colArr.push(grid[j2][i2]);
      for (j2 = 0; j2 + 11 <= n; j2++) {
        if (matches(rowArr, j2, pat1) || matches(rowArr, j2, pat2)) score += 40;
        if (matches(colArr, j2, pat1) || matches(colArr, j2, pat2)) score += 40;
      }
    }
    for (i2 = 0; i2 < n; i2++) for (j2 = 0; j2 < n; j2++) if (grid[i2][j2]) dark++;
    score += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
    return score;
  }

  var best = null, bestScore = Infinity, bestMask = 0;
  for (var pat = 0; pat < 8; pat++) {
    var trial = [];
    for (var rr2 = 0; rr2 < size; rr2++) {
      trial.push(mod[rr2].slice());
      for (var cc2 = 0; cc2 < size; cc2++) {
        if (!reserved[rr2][cc2] && maskAt(pat, rr2, cc2)) trial[rr2][cc2] = !trial[rr2][cc2];
      }
    }
    // Format bits belong to the trial: they change its penalty.
    applyFormat(trial, pat);
    var sc = penalty(trial);
    if (sc < bestScore) { bestScore = sc; best = trial; bestMask = pat; }
  }

  function applyFormat(grid, pattern) {
    var fmt = FORMAT_M[pattern];
    for (var q = 0; q < 15; q++) {
      var bit = ((fmt >> q) & 1) === 1;
      if (q < 6) grid[8][q] = bit;
      else if (q === 6) grid[8][7] = bit;
      else if (q === 7) grid[8][8] = bit;
      else if (q === 8) grid[7][8] = bit;
      else grid[14 - q][8] = bit;

      if (q < 8) grid[8][size - 1 - q] = bit;
      else grid[size - 15 + q][8] = bit;
    }
    grid[size - 8][8] = true;
    if (version >= 7) {
      var vinfo = VERSION_INFO[version];
      for (var w = 0; w < 18; w++) {
        var vbit = ((vinfo >> w) & 1) === 1;
        grid[Math.floor(w / 3)][size - 11 + (w % 3)] = vbit;
        grid[size - 11 + (w % 3)][Math.floor(w / 3)] = vbit;
      }
    }
  }

  return best;
}

/**
 * Minimal PNG writer — 1-bit greyscale, no compression.
 *
 * Apps Script has no canvas, and a Doc will not embed a BMP. A PNG is a few
 * chunks and two checksums, and deflate accepts stored blocks, so the whole
 * thing fits in sixty lines with no dependency.
 */
function qrPng(matrix, scale, quiet) {
  scale = scale || 8;
  quiet = quiet === undefined ? 4 : quiet;
  var n = matrix.length, side = (n + quiet * 2) * scale;

  // One byte per pixel, 0 = black, 255 = white, prefixed by the filter byte.
  var stride = side + 1, raw = [];
  for (var y = 0; y < side; y++) {
    raw.push(0);
    var my = Math.floor(y / scale) - quiet;
    for (var x = 0; x < side; x++) {
      var mx = Math.floor(x / scale) - quiet;
      var dark = my >= 0 && my < n && mx >= 0 && mx < n && matrix[my][mx];
      raw.push(dark ? 0 : 255);
    }
  }

  function crc32(bytes) {
    var c, table = crc32.table;
    if (!table) {
      table = crc32.table = [];
      for (var i = 0; i < 256; i++) {
        c = i;
        for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[i] = c >>> 0;
      }
    }
    c = 0xffffffff;
    for (var b = 0; b < bytes.length; b++) c = table[(c ^ bytes[b]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function be32(v) { return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]; }

  function chunk(type, body) {
    var head = [];
    for (var i = 0; i < 4; i++) head.push(type.charCodeAt(i));
    var full = head.concat(body);
    return be32(body.length).concat(full, be32(crc32(full)));
  }

  // zlib: header, then deflate stored blocks of at most 65535 bytes, then adler.
  var z = [0x78, 0x01];
  for (var off = 0; off < raw.length; off += 65535) {
    var block = raw.slice(off, off + 65535), last = off + 65535 >= raw.length;
    z.push(last ? 1 : 0, block.length & 255, (block.length >> 8) & 255,
           ~block.length & 255, (~block.length >> 8) & 255);
    z = z.concat(block);
  }
  var a = 1, b2 = 0;
  for (var r = 0; r < raw.length; r++) { a = (a + raw[r]) % 65521; b2 = (b2 + a) % 65521; }
  z = z.concat(be32(((b2 << 16) | a) >>> 0));

  var ihdr = be32(side).concat(be32(side), [8, 0, 0, 0, 0]);  // 8-bit greyscale
  return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    .concat(chunk('IHDR', ihdr), chunk('IDAT', z), chunk('IEND', []));
}
