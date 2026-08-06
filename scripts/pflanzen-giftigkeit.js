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

  // — Haut- und Schleimhautkontakt —
  Euphorbia:   'reizend', // Milchsaft, auch augenschädigend
  Ruta:        'reizend', // phototoxisch
  Ammi:        'reizend', // phototoxisch (Furocumarine)
  Heracleum:   'reizend', // phototoxisch
  Dictamnus:   'reizend', // phototoxisch
  Primula:     'reizend', // Kontaktallergie
  Tanacetum:   'reizend',
  Artemisia:   'reizend',
  Alstroemeria:'reizend',
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
const HAUSTIERE = new Set(['Allium', 'Tulipa', 'Narcissus', 'Hyacinthus', 'Convallaria', 'Colchicum', 'Cyclamen']);

// Katzengift eigener Klasse: Echte Lilien und Taglilien lösen bei Katzen akutes Nierenversagen
// aus, und zwar schon über Pollen am Fell oder Vasenwasser. Der allgemeine Haustier-Baustein
// verharmlost das — deshalb ein eigener Text statt der Sammelstufe.
const KATZENGIFT = new Set(['Lilium', 'Hemerocallis']);
const KATZENTEXT = 'Für Katzen lebensgefährlich: Alle Pflanzenteile — auch Pollen am Fell und das Wasser aus der Vase — können akutes Nierenversagen auslösen. In Haushalten mit Katzen nicht pflanzen und nicht als Schnittblume ins Haus holen. Für Menschen ist die Pflanze dagegen wenig problematisch.';

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

module.exports = { giftigkeit, gattung, STUFEN, HAUSTIERE };
