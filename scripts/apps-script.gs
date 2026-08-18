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
 *        ARCHIVE_ANS   durée de conservation des dossiers, en années
 *   4. Déployer en web app, accès « Tout le monde », et reporter l'URL dans
 *      la variable FICHE_WEBHOOK_URL de wrangler.toml.
 *   5. Créer un déclencheur horaire mensuel sur `purgerArchives` — sans lui,
 *      la durée de conservation annoncée au client n'est pas tenue.
 *
 * Répartition du stockage : R2 est un tampon de sept jours pour le travail en
 * ligne — envoi, analyse, URL signées. Drive est l'archive durable, dans le
 * dossier d'intervention. Les liens signés reçus ici expirent avec le dossier,
 * d'où la recopie des fichiers plutôt que la conservation des URL.
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
  var racine = DriveApp.getFolderById(P.getProperty('DOSSIER_ID'));

  // Un sous-dossier par intervention : le technicien ouvre un seul endroit et
  // y trouve la fiche, les photos, les images du bandeau et la vidéo.
  var dossier = racine.createFolder(
    d.ref + ' — ' + (d.ville || 'sans commune') + ' — ' +
      Utilities.formatDate(new Date(), 'Europe/Paris', 'yyyy-MM-dd'),
  );
  var copie = modele.makeCopy('Fiche ' + d.ref, dossier);

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
    // Un Doc ne peut pas embarquer de vidéo : on pose un lien. Il expire avec
    // le dossier, à sept jours — au-delà, la fiche reste lisible sans lui.
    '{{VIDEO}}': d.bandeauVideoUrl || 'Aucune vidéo',
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

  archiver_(dossier, d);

  return { ok: true, doc: copie.getUrl(), pdf: pdf.getUrl(), dossier: dossier.getUrl() };
}

/**
 * Recopie les médias depuis R2 vers le dossier d'intervention.
 *
 * Chaque fichier est isolé dans son propre try : une photo manquante ne doit
 * pas empêcher l'archivage des autres ni faire échouer la fiche, qui est déjà
 * écrite à ce stade.
 */
function archiver_(dossier, d) {
  var aRecopier = [];

  (d.photos || []).forEach(function (p) {
    if (p.url) aRecopier.push({ url: p.url, nom: 'photo-' + p.slot + '.jpg' });
  });
  (d.bandeauFrames || []).forEach(function (f) {
    aRecopier.push({
      url: f.url,
      nom: 'bandeau-' + String(f.index + 1) + '.jpg',
    });
  });
  if (d.bandeauVideoUrl) {
    aRecopier.push({ url: d.bandeauVideoUrl, nom: 'bandeau-source.mp4' });
  }

  aRecopier.forEach(function (item) {
    try {
      var res = UrlFetchApp.fetch(item.url, { muteHttpExceptions: true });
      if (res.getResponseCode() !== 200) {
        console.error('archivage ' + item.nom + ' : HTTP ' + res.getResponseCode());
        return;
      }
      dossier.createFile(res.getBlob().setName(item.nom));
    } catch (err) {
      // Cas le plus probable : vidéo au-delà des 50 Mo qu'UrlFetchApp accepte.
      // Le Worker plafonne en amont, mais la garde reste utile.
      console.error('archivage ' + item.nom + ' impossible : ' + err);
    }
  });
}

/* ------------------------------------------------------------------ */
/* 4. Purge de l'archive                                               */
/* ------------------------------------------------------------------ */

/**
 * Supprime les dossiers d'intervention au-delà de la durée de conservation.
 *
 * À déclencher mensuellement. Sans ce déclencheur, la durée annoncée au client
 * n'est pas tenue et l'archive croît indéfiniment.
 *
 * `setTrashed` et non `removeFile` : la corbeille Drive continue de compter
 * dans le quota et le fichier reste récupérable trente jours, ce qui laisse
 * une marge en cas de purge accidentelle. La suppression définitive intervient
 * ensuite d'elle-même.
 */
function purgerArchives() {
  var ans = Number(P.getProperty('ARCHIVE_ANS') || '2');
  var limite = new Date();
  limite.setFullYear(limite.getFullYear() - ans);

  var racine = DriveApp.getFolderById(P.getProperty('DOSSIER_ID'));
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
    console.log('purge archive : ' + supprimes + ' dossier(s) au-delà de ' + ans + ' ans');
  }
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
