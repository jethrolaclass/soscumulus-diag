# -*- coding: utf-8 -*-
"""Builds the intervention-sheet template as a .docx.

    python3 scripts/build-report-template.py
    → scripts/fiche-intervention.docx, to upload to Drive *converted* to a
      Google Doc, whose id goes in the TEMPLATE_ID script property.

The template is generated rather than drawn by hand because two things have to
be exact and neither survives an HTML or PDF import: the page setup, and the
column widths.

Widths are absolute twips, never percentages: a fixed-layout table takes its
width from the grid, so a percentage on the cells is simply ignored — which is
how the first attempt ended up seven centimetres wide, hugging the left margin.

Colours and fonts are read off the design export, not guessed: see the constants
below. Placeholders match the `fields` map in apps-script.gs; adding one means
adding it in both places.
"""
import os, zipfile, html

# Values read off the design itself (pdftohtml export of the source PDF), not
# guessed from a screenshot: this is the site palette, not the one the
# transactional e-mails use.
NAVY, ORANGE, ORANGE2 = "0f2d5c", "e8552f", "ff8a5c"
GRAY, INK, ICE, PALE_TXT = "6b7a8f", "1b2430", "b9c6da", "e8edf5"
RED, LINE, PALE = "c62828", "cfd8e3", "f4f7fb"

# The sheet was drawn in Syne + DM Sans — the pair the web app used before it
# moved to Montserrat to match soscumulus.fr. Kept as designed; see the note in
# the README about the two type systems now in play.
HEAD_FONT, TEXT_FONT = "Syne", "DM Sans"

PAGE_W, MARGIN = 11906, 567          # A4 portrait, 1 cm margins
W = PAGE_W - 2 * MARGIN              # 10772 twips of usable width

def share(*parts):
    """Column widths from relative shares, the last one absorbing the rounding."""
    total = sum(parts)
    cols = [round(W * p / total) for p in parts[:-1]]
    return cols + [W - sum(cols)]

def esc(t): return html.escape(t, quote=False)

def run(text, sz=17, color=INK, bold=False, head=False):
    font = HEAD_FONT if head else TEXT_FONT
    rpr = f'<w:rPr><w:rFonts w:ascii="{font}" w:hAnsi="{font}"/>'
    if bold: rpr += '<w:b/>'
    rpr += f'<w:color w:val="{color}"/><w:sz w:val="{sz}"/><w:szCs w:val="{sz}"/></w:rPr>'
    return f'<w:r>{rpr}<w:t xml:space="preserve">{esc(text)}</w:t></w:r>'

def para(runs, before=0, after=0, align=None):
    jc = f'<w:jc w:val="{align}"/>' if align else ''
    return (f'<w:p><w:pPr>{jc}<w:spacing w:before="{before}" w:after="{after}"'
            f' w:line="240" w:lineRule="auto"/></w:pPr>{"".join(runs)}</w:p>')

def lbl(t):  return para([run(t, 13, GRAY)], after=0)
def val(t, bold=False, sz=17): return para([run(t, sz, INK, bold)], before=20, after=40)

DOTTED = f'<w:bottom w:val="dotted" w:sz="6" w:space="0" w:color="{LINE}"/>'
TOP    = f'<w:top w:val="single" w:sz="18" w:space="0" w:color="{NAVY}"/>'
def borders(*parts): return f'<w:tcBorders>{"".join(parts)}</w:tcBorders>'
BOX = borders(f'<w:top w:val="single" w:sz="4" w:space="0" w:color="{LINE}"/>',
              f'<w:left w:val="single" w:sz="4" w:space="0" w:color="{LINE}"/>',
              f'<w:bottom w:val="single" w:sz="4" w:space="0" w:color="{LINE}"/>',
              f'<w:right w:val="single" w:sz="4" w:space="0" w:color="{LINE}"/>')

def C(content, span=1, shd=None, bd=None):
    return {"c": content, "span": span, "shd": shd, "bd": bd}

def tbl(cols, rows):
    grid = "".join(f'<w:gridCol w:w="{c}"/>' for c in cols)
    pr = (f'<w:tblPr><w:tblW w:w="{sum(cols)}" w:type="dxa"/>'
          '<w:tblLayout w:type="fixed"/><w:tblCellMar>'
          '<w:left w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/>'
          '</w:tblCellMar></w:tblPr>')
    body = []
    for row in rows:
        i, cells = 0, []
        for c in row:
            width = sum(cols[i:i + c["span"]]); i += c["span"]
            tcpr = f'<w:tcPr><w:tcW w:w="{width}" w:type="dxa"/>'
            if c["span"] > 1: tcpr += f'<w:gridSpan w:val="{c["span"]}"/>'
            if c["shd"]: tcpr += f'<w:shd w:val="clear" w:color="auto" w:fill="{c["shd"]}"/>'
            if c["bd"]: tcpr += c["bd"]
            tcpr += ('<w:tcMar><w:top w:w="60" w:type="dxa"/><w:left w:w="90" w:type="dxa"/>'
                     '<w:bottom w:w="60" w:type="dxa"/><w:right w:w="90" w:type="dxa"/></w:tcMar></w:tcPr>')
            cells.append(f'<w:tc>{tcpr}{c["c"]}</w:tc>')
        body.append(f'<w:tr>{"".join(cells)}</w:tr>')
    return f'<w:tbl>{pr}<w:tblGrid>{grid}</w:tblGrid>{"".join(body)}</w:tbl>'

SPACER = ('<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" '
          'w:lineRule="exact"/></w:pPr></w:p>')
B = []
def add(el):
    # Two touching tables with the same grid get merged by Word; a thin
    # paragraph between them is what keeps the red banner out of the table above.
    if B and B[-1].startswith('<w:tbl') and el.startswith('<w:tbl'): B.append(SPACER)
    B.append(el)

def section(t): add(para([run(t, 20, NAVY, True, head=True)], before=200, after=60))
def field(label, value, span=1, top=False, bold=False):
    return C(lbl(label) + val(value, bold), span,
             bd=borders(TOP, DOTTED) if top else borders(DOTTED))

HALF, THIRD, QUARTER = share(1, 1), share(34, 36, 30), share(1, 1, 1, 1)
FULL, HEAD = [W], share(52, 48)

def header(subtitle, right):
    add(tbl(HEAD, [[
        C(para([run("SOS Cumulus ", 24, "ffffff", True, head=True), run("+", 24, ORANGE, True, head=True)]) +
          para([run(subtitle, 28, "ffffff", head=True)], before=60), shd=NAVY),
        C("".join(right), shd=NAVY)]]))

header("Ordre d'intervention", [
    para([run("Dossier {{REF}}", 26, ORANGE2, True, head=True)], align="right"),
    para([run("Date : {{DATE}}  ·  Urgence : {{URGENCE}}", 15, ICE)], before=60, align="right"),
    para([run("☐ Normale     ☐ Élevée", 17, "ffffff")], before=80, align="right"),
    para([run("Page 1 : remplie par le bureau · Page 2 : remplie par le technicien sur place.",
              13, ICE)], before=80, align="right")])

section("Client & lieu")
add(tbl(HALF, [
    [field("NOM ET PRÉNOM", "{{NOM}}", top=True, bold=True),
     field("TÉLÉPHONE(S)", "{{TEL}}", top=True, bold=True)],
    [field("ADRESSE COMPLÈTE — ÉTAGE, CODE, INTERPHONE", "{{ADRESSE}}"),
     field("QUI SERA PRÉSENT SUR PLACE", " ")],
    [field("STATUT", "{{OCCUPANT}}"), field("PAYEUR SI DIFFÉRENT (NOM, CONTACT)", " ")],
    [field("ACCÈS — PLACARD, TRAPPE, CAVE, ESCALIER, STATIONNEMENT", "{{ACCES}}"),
     field("JOIGNABLE", "{{DISPO}}")]]))

section("Appareil en place")
add(tbl(THIRD, [
    [field("MARQUE", "{{MARQUE}}", top=True),
     field("MODÈLE", "{{MODELE}}", top=True, bold=True),
     field("CAPACITÉ (L)", "{{CAPACITE}}", top=True)],
    [field("ORIENTATION", "☐ Vertical mural   ☐ Horizontal   ☐ Au sol"),
     field("ÉLECTRONIQUE (ÉCRAN / VOYANTS)", "{{ECRAN}}"),
     field("N° SÉRIE / FAB — ANNÉE ESTIMÉE", "{{SERIE}}")],
    [C(lbl("PLAQUE SIGNALÉTIQUE — RELEVÉ COMPLET") + val("{{PLAQUE}}", sz=16), 3, shd=PALE)],
    [C(lbl("BANDEAU DE COMMANDE") + val("{{BANDEAU}}", sz=16) +
       para([run("Vidéo : {{VIDEO}}", 13, GRAY)], after=40), 3, shd=PALE)]]))

section("Diagnostic établi à distance")
add(tbl(FULL, [
    [C(lbl("SYMPTÔME CONSTATÉ") + val("{{PROBLEME}}") + val("{{SYNTHESE}}", sz=16),
       bd=borders(TOP, DOTTED))],
    [field("HYPOTHÈSE RETENUE — CONFIANCE : {{CONFIANCE}}", "{{CAUSE}}")],
    [field("POINT À VÉRIFIER EN PREMIER SUR PLACE", "{{ACTION}}")],
    [field("NOTES TECHNICIEN — VISITE SUR SITE : {{VISITE}} · DURÉE ESTIMÉE : {{DUREE}}",
           "{{NOTES}}")]]))

section("Photos et vidéos du dossier")
add(tbl(share(30, 70), [[
    C(para([run("{{QR}}", 17)]), bd=borders(TOP)),
    C(lbl("SCANNEZ, OU OUVREZ LE LIEN") +
      para([run("{{MEDIA}}", 15, NAVY)], before=20, after=40) +
      para([run("Photos du client, images du bandeau et vidéo source. "
                "Conservé deux ans.", 13, GRAY)], after=40), bd=borders(TOP))]]))

section("Intervention prévue")
add(tbl(HALF, [
    [field("NATURE", "☐ Réparation   ☐ Remplacement   ☐ Diagnostic sur place", top=True),
     field("FOURNISSEUR / DÉPÔT DE RETRAIT", " ", top=True)],
    [field("MATÉRIEL PRÉVU — RÉFÉRENCE EXACTE", "{{PIECES}}", span=2)],
    [field("FORFAIT TECHNICIEN (€) — IDENTIQUE RÉPARATION OU REMPLACEMENT", " "),
     field("DEVIS CLIENT VALIDÉ LE — MONTANT TTC — ACOMPTE ENCAISSÉ LE", " ")]]))

add(tbl(FULL, [[C(para([
    run("AVANT DE PARTIR   ", 13, "ffffff"),
    run("Devis signé et acompte encaissé — sinon on ne part pas.", 16, "ffffff", True),
    run("   Vérifié par le bureau :   ☐ Oui", 16, "ffffff")]), shd=RED)]]))

rules = lambda items: "".join(para([run(t, 15, "ffffff")], before=60) for t in items)
add(tbl(HALF, [
    [C(para([run("LES RÈGLES, QUEL QUE SOIT L'INTERVENANT", 16, ORANGE2, True, head=True)]), 2, shd=NAVY)],
    [C(rules(["• Photos AVANT obligatoires pour démarrer — envoyées sur le WhatsApp du dossier.",
              "• Preuve photo de la panne avant tout remplacement (la cuve percée se photographie).",
              "• On ne touche jamais au bâti — plafond, coffrage, saignée : le client ou son entreprise."]), shd=NAVY),
     C(rules(["• Jamais d'encaissement direct — pas d'espèces, pas de virement au technicien : l'argent passe par SOS Cumulus.",
              "• Le PV page 2 est signé avant de partir, photos APRÈS comprises.",
              "• Un doute ? On appelle le référent avant d'improviser."]), shd=NAVY)],
    [C(para([run("Référent technique : ............................     Bureau : ............................",
                 15, ICE)], before=40), 2, shd=NAVY)]]))
add(para([run("SOS Cumulus — Ordre d'intervention & compte rendu · template V1        Page 1/3",
              13, GRAY)], before=120))
add('<w:p><w:r><w:br w:type="page"/></w:r></w:p>')

header("Compte rendu d'intervention", [
    para([run("Dossier {{REF}}", 26, ORANGE2, True, head=True)], align="right"),
    para([run("Technicien : ..............................", 15, ICE)], before=60, align="right"),
    para([run("Arrivée : ................ · Départ : ................", 15, ICE)], before=40, align="right")])

section("Photos du dossier — cochées quand envoyées sur le WhatsApp du dossier")
shot = lambda t, s: C(para([run("☐ " + t, 16, INK, True)]) +
                      para([run(s, 13, GRAY)], before=40, after=40), bd=BOX)
add(tbl(QUARTER, [[shot("AVANT", "vue d'ensemble + zone concernée"),
                   shot("LA PANNE", "preuve photo (obligatoire si remplacement)"),
                   shot("APRÈS", "installation finie + zone propre"),
                   shot("PLAQUE du neuf", "étiquette du nouvel appareil posé")]]))

section("Constat sur place")
blank = para([run(" ", 17)], before=280, after=60)
add(tbl(FULL, [
    [C(lbl("LE DIAGNOSTIC À DISTANCE ÉTAIT-IL CONFIRMÉ ?") +
       val("☐ Oui, confirmé   ☐ Partiellement   ☐ Non — constat réel ci-dessous"),
       bd=borders(TOP, DOTTED))],
    [C(lbl("CONSTAT RÉEL / ÉCART AVEC LE DIAGNOSTIC (NOURRIT NOTRE FIABILITÉ — SANS CONSÉQUENCE POUR LE TECHNICIEN)") + blank, bd=borders(DOTTED))],
    [C(lbl("TRAVAUX RÉALISÉS") + val("☐ Remplacement   ☐ Réparation   ☐ Rien à faire / conseil"),
       bd=borders(DOTTED))],
    [C(lbl("IMPRÉVUS, ANOMALIES, TEMPS SUPPLÉMENTAIRE — ET CONSOMMABLES UTILISÉS") + blank,
       bd=borders(DOTTED))]]))

section("Base de compatibilité — la partie qui vaut de l'or, 2 minutes à remplir")
add(para([run("À relever une fois l'ancien déposé, avant de remonter le neuf — ces cotes évitent le prochain déplacement pour rien.", 13, GRAY)], after=80))
COMPAT = share(46, 27, 27)
rows = [[C(para([run(" ", 13)]), shd=PALE, bd=BOX),
         C(para([run("ANCIEN APPAREIL (DÉPOSÉ)", 13, GRAY)]), shd=PALE, bd=BOX),
         C(para([run("NOUVEAU POSÉ", 13, GRAY)]), shd=PALE, bd=BOX)]]
for t in ["Marque · modèle · capacité", "Entraxe de fixation (mm)", "Diamètre (mm)",
          "Hauteur totale (mm)", "Raccordement (dessous / côté)",
          "Fixation (barre, tiges) — réutilisée ?"]:
    rows.append([C(para([run(t, 16, INK, True)], before=50, after=50), bd=BOX),
                 C(para([run(" ", 16)], before=50, after=50), bd=BOX),
                 C(para([run(" ", 16)], before=50, after=50), bd=BOX)])
add(tbl(COMPAT, rows))
add(para([run("REMARQUE DE COMPATIBILITÉ (« TEL MODÈLE VA SUR TEL ANCIEN SANS REPERCER », PIÈGE D'ACCÈS, COTE CRITIQUE…)", 13, GRAY)], before=100))
add(tbl(FULL, [[C(blank, bd=borders(DOTTED))]]))

section("Réception & règlement")
add(para([run("« Travaux décrits ci-dessus réalisés ce jour, fonctionnement démontré, lieux laissés propres — lu et approuvé. »", 15, GRAY)], after=80))
sign = lambda t: C(lbl(t) + para([run(" ", 17)], before=520, after=60), bd=BOX)
add(tbl(HALF, [[sign("NOM ET SIGNATURE DU CLIENT — DATE"), sign("SIGNATURE DU TECHNICIEN")]]))
add(para([run("Solde TTC : ................    ", 16, INK, True),
          run("☐ Réglé par lien de paiement SOS Cumulus    encaissé à ................", 16)],
         before=140))
add(para([run("Jamais d'espèces ni de virement au technicien.", 13, GRAY)], before=30))
add(para([run("AVANT DE QUITTER LES LIEUX", 13, GRAY)], before=140))
add(para([run("☐ Sticker QR posé    ☐ Flyers (collectif)    ☐ Notice remise    ☐ Photos APRÈS envoyées    ☐ PV signé    ☐ Solde encaissé", 16)], before=30))
add(para([run("Avis Google demandé par le bureau après validation du CR · technicien réglé sous 48 h après validation.", 13, GRAY)], before=30))
add(para([run("SOS Cumulus — Ordre d'intervention & compte rendu · template V1        Page 2/3",
              13, GRAY)], before=120))
add('<w:p><w:r><w:br w:type="page"/></w:r></w:p>')

header("Photos transmises par le client", [
    para([run("Dossier {{REF}}", 26, ORANGE2, True, head=True)], align="right"),
    para([run("Prises pendant le diagnostic à distance", 15, ICE)], before=60, align="right")])
add(para([run("{{PHOTOS}}", 17)], before=120))
add(para([run("SOS Cumulus — Ordre d'intervention & compte rendu · template V1        Page 3/3",
              13, GRAY)], before=120))

SECT = (f'<w:sectPr><w:pgSz w:w="{PAGE_W}" w:h="16838"/>'
        f'<w:pgMar w:top="{MARGIN}" w:right="{MARGIN}" w:bottom="{MARGIN}" w:left="{MARGIN}"'
        ' w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>')
DOC = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
       '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
       f'<w:body>{"".join(B)}{SECT}</w:body></w:document>')
CT = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      '<Default Extension="xml" ContentType="application/xml"/>'
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      '</Types>')
RELS = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
        '</Relationships>')
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fiche-intervention.docx')
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', CT); z.writestr('_rels/.rels', RELS)
    z.writestr('word/document.xml', DOC)
print(f'{out} — {len(B)} blocs, largeur utile {W} twips')
