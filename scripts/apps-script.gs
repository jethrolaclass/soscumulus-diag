/**
 * SOS Cumulus — pont Google Apps Script.
 *
 * Deux rôles dans un seul web app :
 *
 *  1. RELAIS DE LEAD — le formulaire de soscumulus.fr poste déjà ici. On
 *     conserve le comportement existant (Sheet, e-mail) et on ajoute un appel
 *     à l'API de diagnostic, qui crée le dossier et envoie le SMS.
 *
 *  2. GÉNÉRATION DE FICHE — l'API rappelle ce script quand un dossier est
 *     complet. Le script remplit un template Google Docs et l'exporte en PDF.
 *
 * Installation :
 *   1. Ouvrir le projet Apps Script déjà relié au formulaire.
 *   2. Coller ce fichier (ou fusionner `doPost` avec l'existant).
 *   3. Renseigner les propriétés du script (Paramètres du projet → Propriétés) :
 *        API_URL      https://api.diag.soscumulus.fr
 *        LEAD_SECRET   identique au secret Worker
 *        FICHE_SECRET  identique au secret Worker
 *        TEMPLATE_ID   id du Google Doc modèle
 *        DOSSIER_ID    id du dossier Drive où déposer les fiches
 *        ALERTE_EMAIL  destinataire des alertes sécurité
 *   4. Déployer en web app, accès « Tout le monde », et reporter l'URL dans
 *      la variable FICHE_WEBHOOK_URL de wrangler.toml.
 */

var P = PropertiesService.getScriptProperties();

function doPost(e) {
  var body = {};
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    // Le formulaire du site poste en form-urlencoded, pas en JSON.
    body = e.parameter || {};
  }

  // Les appels venant du Worker portent un secret et un champ `type`.
  var secret = (e.parameter && e.parameter.secret) || headerSecret(e);
  if (body.type === 'fiche' && secretOk(secret, P.getProperty('FICHE_SECRET'))) {
    return json(genererFiche(body));
  }
  if (body.type === 'alerte_securite' && secretOk(secret, P.getProperty('FICHE_SECRET'))) {
    return json(alerteSecurite(body));
  }

  // Sinon : soumission du formulaire public.
  return json(traiterLead(body));
}

/* ------------------------------------------------------------------ */
/* 1. Relais de lead                                                   */
/* ------------------------------------------------------------------ */

function traiterLead(data) {
  // --- Comportement existant : conserver vos lignes actuelles ici ---
  // enregistrerDansSheet_(data);
  // envoyerEmailEquipe_(data);

  var res = { ok: true };
  try {
    var reponse = UrlFetchApp.fetch(P.getProperty('API_URL') + '/api/lead', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-lead-secret': P.getProperty('LEAD_SECRET') },
      payload: JSON.stringify({
        tel: data.tel,
        ville: data.ville,
        probleme: data.probleme,
        source: 'formulaire_site',
      }),
      muteHttpExceptions: true,
    });
    var code = reponse.getResponseCode();
    if (code >= 200 && code < 300) {
      res.diag = JSON.parse(reponse.getContentText());
    } else {
      // Le lead est déjà enregistré côté Sheet : un échec ici ne doit jamais
      // faire échouer la soumission du formulaire vue par le client.
      console.error('API diag ' + code + ' ' + reponse.getContentText());
    }
  } catch (err) {
    console.error('API diag injoignable : ' + err);
  }
  return res;
}

/* ------------------------------------------------------------------ */
/* 2. Fiche d'intervention                                             */
/* ------------------------------------------------------------------ */

function genererFiche(d) {
  var modele = DriveApp.getFileById(P.getProperty('TEMPLATE_ID'));
  var dossier = DriveApp.getFolderById(P.getProperty('DOSSIER_ID'));
  var copie = modele.makeCopy('Fiche ' + d.ref + ' — ' + (d.ville || ''), dossier);

  var doc = DocumentApp.openById(copie.getId());
  var corps = doc.getBody();
  var diag = d.diagnostic || {};
  var plaque = plaqueDe_(d);

  var champs = {
    '{{REF}}': d.ref || '',
    '{{TEL}}': d.tel || '',
    '{{VILLE}}': d.ville || '',
    '{{PROBLEME}}': d.probleme || '',
    '{{DATE}}': Utilities.formatDate(new Date(), 'Europe/Paris', 'dd/MM/yyyy HH:mm'),
    '{{APPAREIL}}': [plaque.brand, plaque.model, plaque.capacityLiters ? plaque.capacityLiters + ' L' : '']
      .filter(String).join(' · ') || 'Non identifié',
    '{{SYNTHESE}}': diag.summary || '',
    '{{CAUSE}}': diag.likelyCause || '',
    '{{ACTION}}': diag.recommendedAction || '',
    '{{URGENCE}}': diag.urgency || '',
    '{{PIECES}}': (diag.partsLikely || []).join(', ') || 'À confirmer',
    '{{DUREE}}': diag.estimatedDurationMin ? diag.estimatedDurationMin + ' min' : 'À estimer',
    '{{CONFIANCE}}': diag.confidence || '',
    '{{VISITE}}': diag.needsOnSite ? 'Oui' : 'Non',
    '{{NOTES}}': diag.technicianNotes || '',
    '{{BANDEAU}}': bandeauTexte_(d.bandeau),
    '{{ACCES}}': (d.answers && d.answers.acces) || '',
    '{{DISPO}}': (d.answers && d.answers.dispo) || '',
  };
  for (var cle in champs) corps.replaceText(escapeRegex_(cle), champs[cle]);

  // Les photos sont insérées dans le document, pas liées : les URL signées
  // expirent avec le dossier, et la fiche doit rester consultable après.
  var ancre = corps.findText('{{PHOTOS}}');
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
        console.error('photo ' + p.slot + ' non récupérée : ' + err);
      }
    });
  }

  doc.saveAndClose();
  var pdf = dossier.createFile(copie.getAs('application/pdf')).setName('Fiche ' + d.ref + '.pdf');
  return { ok: true, doc: copie.getUrl(), pdf: pdf.getUrl() };
}

/** Rendu lisible de l'analyse du bandeau pour la fiche papier. */
function bandeauTexte_(b) {
  if (!b) return 'Non renseigné';
  var lignes = [];
  if (b.code) lignes.push('Code affiché : ' + b.code);
  if (b.blinkPattern) lignes.push('Séquence : ' + b.blinkPattern);
  if (b.indicators && b.indicators.length) lignes.push('Voyants : ' + b.indicators.join(', '));
  if (b.interpretation) lignes.push('Lecture : ' + b.interpretation);
  return lignes.length ? lignes.join('\n') : 'Aucun signal exploitable';
}

function plaqueDe_(d) {
  var p1 = (d.photos || []).filter(function (p) { return p.slot === 1; })[0];
  return (p1 && p1.analysis && p1.analysis.nameplate) || {};
}

/* ------------------------------------------------------------------ */
/* 3. Alerte sécurité                                                  */
/* ------------------------------------------------------------------ */

function alerteSecurite(d) {
  var libelles = {
    disjoncteur: 'Disjoncteur qui saute',
    eau_electricite: 'Eau à proximité d\'installations électriques',
    gaz: 'Odeur de gaz',
  };
  var motifs = (d.flags || []).map(function (f) { return libelles[f] || f; }).join(' · ');

  MailApp.sendEmail({
    to: P.getProperty('ALERTE_EMAIL'),
    subject: '[URGENT] Danger déclaré — dossier ' + d.ref,
    body:
      'Un client a déclaré une situation dangereuse pendant le diagnostic.\n\n' +
      'Dossier : ' + d.ref + '\n' +
      'Téléphone : ' + d.tel + '\n' +
      'Commune : ' + (d.ville || 'non renseignée') + '\n' +
      'Motif : ' + motifs + '\n\n' +
      'Le parcours a été interrompu. Rappeler immédiatement.',
  });
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Utilitaires                                                         */
/* ------------------------------------------------------------------ */

function headerSecret(e) {
  // Apps Script n'expose pas les en-têtes personnalisés dans doPost. Le Worker
  // envoie donc aussi le secret en paramètre de requête ; conserver l'appel en
  // HTTPS suffit à le protéger en transit.
  return (e.parameter && e.parameter.secret) || '';
}

function secretOk(fourni, attendu) {
  return Boolean(attendu) && fourni === attendu;
}

function escapeRegex_(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON,
  );
}
