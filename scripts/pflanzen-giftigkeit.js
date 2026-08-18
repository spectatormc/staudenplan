// Kuratierte Giftigkeits-Einstufung auf Gattungsebene, plus fester Warntext je Stufe.
//
// Bewusst NICHT generiert: Eine Giftwarnung ist eine Aussage, für die der Betreiber haftet.
// Sie muss nachschlagbar und über den ganzen Bestand einheitlich sein, nicht je Seite neu
// formuliert. Die Liste ist Gattungsebene — das ist die Ebene, auf der die Aussage trägt;
// wo eine Art innerhalb der Gattung harmloser ist, warnt sie zu viel statt zu wenig.
//
// Ergänzt am 06.08.2026, nachdem eine Fachprüfung ergab: von 288 generierten Pflegetexten
// erwähnten 5 die Giftigkeit — bei mindestens 8 einschlägigen Arten in der Stichprobe,
// darunter die Herbstzeitlose ohne ein Wort zu Colchicin.

// stark  = Verzehr kann lebensgefährlich sein
// giftig = deutlich giftig, Verzehr gesundheitsschädlich
// reizend = vor allem Haut-/Schleimhautkontakt
const STUFEN = {
  // — lebensgefährlich —
  Aconitum:    'stark',   // Aconitin, auch Hautresorption
  Colchicum:   'stark',   // Colchicin, kein Gegenmittel, Bärlauch-Verwechslung
  Convallaria: 'stark',   // Herzglykoside, Bärlauch-Verwechslung
  Digitalis:   'stark',   // Herzglykoside
  Veratrum:    'stark',   // Alkaloide, Verwechslung mit Gelbem Enzian
  Delphinium:  'stark',
  Actaea:      'stark',   // inkl. der früher als Cimicifuga geführten Arten
  Cimicifuga:  'stark',

  // — deutlich giftig —
  Helleborus:  'giftig',
  Ranunculus:  'giftig',
  Anemone:     'giftig',
  Caltha:      'giftig',
  Pulsatilla:  'giftig',
  Trollius:    'giftig',
  Aquilegia:   'giftig',
  Clematis:    'giftig',
  Lupinus:     'giftig',
  Narcissus:   'giftig',
  Galanthus:   'giftig',
  Hyacinthus:  'giftig',
  Scilla:      'giftig',
  Arum:        'giftig',
  Calla:       'giftig',
  Zantedeschia:'giftig',
  Cyclamen:    'giftig',
  Iris:        'giftig',   // vor allem Rhizom
  Lobelia:     'giftig',
  Asclepias:   'giftig',
  Vinca:       'giftig',
  Chelidonium: 'giftig',
  Papaver:     'giftig',
  Polygonatum: 'giftig',   // Beeren; Blätter werden mit Bärlauch verwechselt
  Maianthemum: 'giftig',
  Paris:       'giftig',
  Aristolochia:'giftig',
  Bryonia:     'giftig',
  Datura:      'stark',
  Nicotiana:   'giftig',
  Solanum:     'giftig',
  Atropa:      'stark',
  Gloriosa:    'stark',
  Ricinus:     'stark',
  Laburnum:    'stark',
  Daphne:      'stark',
  Symphytum:   'giftig',
  Senecio:     'giftig',
  Jacobaea:    'giftig',
  Phytolacca:  'giftig',
  Podophyllum: 'giftig',
  Nerium:      'giftig',
  Taxus:       'stark',

  // Ergänzt am 09.08.2026, nachdem eine Prüfung der Hahnenfußgewächse ergab: 37 von 44
  // Arten hatten einen Eintrag, sieben nicht. Das Leberblümchen stand bereits ohne Warnung
  // auf einem fertigen Pinterest-Bild, während sein naher Verwandter Buschwindröschen
  // gewarnt wurde. Seitdem trägt diese Liste zusätzlich den Filter „Kindersicher" — sie ist
  // nicht mehr nur Hinweistext, sondern entscheidet, was der Planer überhaupt vorschlägt.
  Hepatica:    'giftig',  // Protoanemonin wie bei den übrigen Hahnenfußgewächsen
  Thalictrum:  'giftig',  // Alkaloide
  Eranthis:    'stark',   // herzwirksame Glykoside, blüht als eines der ersten im Garten
  // Weitere Gattungen im Bestand, deren Giftigkeit gut belegt ist. Auf Gattungsebene wie
  // der Rest der Liste: lieber einmal zu viel gewarnt als einmal zu wenig.
  Corydalis:   'giftig',  // Isochinolin-Alkaloide
  Lamprocapnos:'giftig',  // Tränendes Herz, Alkaloide, dazu hautreizend
  Dicentra:    'giftig',
  Diphylleia:  'giftig',  // wie Podophyllum
  Ornithogalum:'giftig',  // herzwirksame Glykoside
  Leucojum:    'giftig',  // Amaryllisgewächs-Alkaloide wie Galanthus
  Fritillaria: 'giftig',  // Alkaloide
  Hyacinthoides:'giftig', // wie Scilla
  Chionodoxa:  'giftig',
  Puschkinia:  'giftig',
  Muscari:     'giftig',  // Saponine
  Sarcococca:  'giftig',  // Buchsbaumgewächs, Steroidalkaloide
  Pachysandra: 'giftig',  // ebenfalls Buchsbaumgewächs
  Echium:      'giftig',  // Pyrrolizidinalkaloide wie Symphytum
  Petasites:   'giftig',  // Pyrrolizidinalkaloide
  Amsonia:     'giftig',  // Hundsgiftgewächs, Milchsaft
  Trillium:    'giftig',  // Saponine
  Nuphar:      'giftig',
  Nymphaea:    'giftig',


  // Nachtrag 18.08.2026. Anlass: eine Prüfung des AUSGABEPFADS, nicht der Liste — auf den
  // erzeugten Pinterest-Pins standen Arten, deren Gattung hier fehlte, obwohl die jeweils
  // stoffgleiche Verwandtschaft längst gelistet war. Jede Zeile unten hat einen solchen
  // Nachbarn in der Liste; das war das Auswahlkriterium, nicht ein allgemeiner Verdacht.
  Baptisia:    'giftig',  // Chinolizidinalkaloide wie Lupinus und Laburnum
  Thermopsis:  'giftig',  // Cytisin, dieselbe Klasse
  Meconopsis:  'giftig',  // Mohngewächs wie Papaver, Chelidonium, Corydalis
  Ligularia:   'giftig',  // Pyrrolizidinalkaloide wie Senecio, Petasites, Symphytum
  Packera:     'giftig',  // Abspaltung von Senecio (P. aurea = S. aureus)
  Teucrium:    'giftig',  // Teucrin A, dokumentierte Leberschäden
  Dryopteris:  'giftig',  // Filicin und Thiaminase — der klassische Giftfarn
  Erysimum:    'giftig',  // herzwirksame Glykoside (Erysimosid)
  Saponaria:   'giftig',  // Saponine, Verzehr reizt Magen und Darm
  Veronicastrum:'giftig', // Wurzel stark brechreizend und abführend
  // — Haut- und Schleimhautkontakt —
  Angelica:    'reizend', // Furocumarine, phototoxisch wie Heracleum
  Ferula:      'reizend', // Doldenblütler, phototoxisch
  Hypericum:   'reizend', // Hypericin, photosensibilisierend
  Helenium:    'reizend', // Sesquiterpenlactone, Kontaktdermatitis
  Euphorbia:   'reizend', // Milchsaft, auch augenschädigend
  Ruta:        'reizend', // phototoxisch
  Ammi:        'reizend', // phototoxisch (Furocumarine)
  Heracleum:   'reizend', // phototoxisch
  Dictamnus:   'reizend', // phototoxisch
  Primula:     'reizend', // Kontaktallergie
  Tanacetum:   'reizend',
  Artemisia:   'reizend',
  Alstroemeria:'reizend',
  Leucanthemum:'reizend',   // Sesquiterpenlactone wie Tanacetum und Helenium
  Leucanthemella:'reizend', // dieselbe Verwandtschaft
};

// Zusätze, wo die Gattungsaussage allein zu wenig sagt.
const ZUSAETZE = {
  Colchicum:   'Die Blätter erscheinen im Frühjahr und werden regelmäßig mit Bärlauch verwechselt — Verwechslungen verlaufen häufig tödlich.',
  Convallaria: 'Die Blätter werden im Frühjahr regelmäßig mit Bärlauch verwechselt.',
  Aconitum:    'Das Gift wird auch über die Haut aufgenommen — bei jedem Handgriff Handschuhe tragen.',
  Euphorbia:   'Der Milchsaft reizt Haut und Augen stark; austretenden Saft sofort abwaschen.',
  Ruta:        'Der Saft reagiert im Sonnenlicht phototoxisch und kann schwere Verbrennungen auslösen.',
  Ammi:        'Der Saft reagiert im Sonnenlicht phototoxisch — Ausputzen und Schnitt nur mit Handschuhen und langen Ärmeln.',
  Heracleum:   'Der Saft reagiert im Sonnenlicht phototoxisch und kann schwere Verbrennungen auslösen.',
  Dictamnus:   'Die ätherischen Öle können im Sonnenlicht Hautreizungen auslösen.',
};

// Für Haustiere gesondert relevant (auch wenn für Menschen weniger kritisch).
// Hosta kam am 18.08.2026 dazu: Saponine, für Hund und Katze giftig — mit 10 Arten im
// Bestand die häufigste Schattenstaude überhaupt. Nectaroscordum und Ipheion sind
// Allium-Abspaltungen und erben dessen Einstufung.
const HAUSTIERE = new Set(['Allium', 'Tulipa', 'Narcissus', 'Hyacinthus', 'Convallaria', 'Colchicum', 'Cyclamen',
                           'Hosta', 'Nectaroscordum', 'Ipheion']);

// Katzengift eigener Klasse: Echte Lilien und Taglilien lösen bei Katzen akutes Nierenversagen
// aus, und zwar schon über Pollen am Fell oder Vasenwasser. Der allgemeine Haustier-Baustein
// verharmlost das — deshalb ein eigener Text statt der Sammelstufe.
const KATZENGIFT = new Set(['Lilium', 'Hemerocallis']);
const KATZENTEXT = 'Für Katzen lebensgefährlich: Alle Pflanzenteile — auch Pollen am Fell und das Wasser aus der Vase — können akutes Nierenversagen auslösen. In Haushalten mit Katzen nicht pflanzen und nicht als Schnittblume ins Haus holen. Für Menschen ist die Pflanze dagegen wenig problematisch.';

/*
 * Verletzungsgefahr — Dornen, Stacheln, stechende Blattspitzen.
 *
 * Getrennt von der Giftigkeit, weil es eine andere Gefahr ist und im Pflanzentext anders
 * beschrieben gehört. Für die Auswahl „Kindersicher" zählt sie aber genauso: Die Palmlilie
 * hat nadelspitze Blattenden auf Augenhöhe eines Kleinkinds, und eine Mannstreu ist kein
 * Spielrasenrand. Der Nutzer hat ausdrücklich gesagt, es dürfe nichts verwendet werden,
 * „das auch nur im Ansatz gefährlich ist".
 */
const VERLETZUNG = {
  Rosa:       'Dornen',
  Eryngium:   'stechende Blätter und Blütenköpfe',
  Acanthus:   'stachelige Blattränder',
  Yucca:      'nadelspitze Blattenden',
  Carlina:    'stechende Hüllblätter',
  Cirsium:    'Stacheln',
  Echinops:   'stechende Blätter',
  Gunnera:    'stachelige Blattstiele',
  Berberis:   'Dornen',
  Onopordum:  'Stacheln',
  Dipsacus:   'stechende Hüllblätter und Stängel',  // steht im Naturgarten-Beispielbeet
  Cortaderia: 'schneidende Blattränder',
};

/*
 * Für die Auswahl „Kindersicher": Gibt einen Grund zurück, wenn die Pflanze dort NICHT
 * hingehört, sonst null. Bewusst streng — jede Stufe zählt, auch „reizend" und „nur für
 * Haustiere giftig", denn ein Kind steckt sich Pflanzenteile genauso in den Mund wie ein Hund.
 */
function kindersicherGrund(nameBotanisch) {
  const g = gattung(nameBotanisch);
  if (VERLETZUNG[g]) return `Verletzungsgefahr: ${VERLETZUNG[g]}`;
  const gift = giftigkeit(nameBotanisch);
  if (!gift) return null;
  return ({ stark: 'stark giftig', giftig: 'giftig', reizend: 'hautreizend',
            katzen: 'für Katzen lebensgefährlich', haustiere: 'für Haustiere giftig' })[gift.stufe] || 'giftig';
}
const istKindersicher = nameBotanisch => kindersicherGrund(nameBotanisch) === null;

const BASISTEXT = {
  stark:   'Alle Pflanzenteile sind stark giftig, ein Verzehr kann lebensgefährlich sein. In Gärten mit kleinen Kindern besser auf einen anderen Standort ausweichen; bei Pflege- und Teilungsarbeiten Handschuhe tragen.',
  giftig:  'Die Pflanze ist giftig, Pflanzenteile gehören nicht in den Mund. In Familiengärten einen Platz abseits der Spielbereiche wählen.',
  reizend: 'Pflanzensaft und Blattwerk können Haut und Schleimhäute reizen. Bei Rückschnitt und Teilung Handschuhe tragen.',
};

function gattung(nameBotanisch) {
  return String(nameBotanisch || '').trim().split(/\s+/)[0];
}

// Liefert { stufe, text } oder null, wenn die Gattung nicht gelistet ist.
function giftigkeit(nameBotanisch) {
  const g = gattung(nameBotanisch);
  if (KATZENGIFT.has(g)) return { stufe: 'katzen', text: KATZENTEXT };

  const stufe = STUFEN[g];
  const haustier = HAUSTIERE.has(g);
  if (!stufe && !haustier) return null;

  const teile = [];
  if (stufe) teile.push(BASISTEXT[stufe]);
  if (ZUSAETZE[g]) teile.push(ZUSAETZE[g]);
  // Ohne vorangehenden Satz hinge ein "Auch für …" grammatisch in der Luft.
  if (haustier) teile.push(stufe
    ? 'Auch für Hunde, Katzen und Kleintiere giftig.'
    : 'Für Hunde, Katzen und Kleintiere giftig — für Menschen ist die Pflanze weniger problematisch.');
  return { stufe: stufe || 'haustiere', text: teile.join(' ') };
}

module.exports = { giftigkeit, gattung, STUFEN, HAUSTIERE, VERLETZUNG,
                   kindersicherGrund, istKindersicher };
