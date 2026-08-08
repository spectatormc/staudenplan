// Gemeinsame Regelbasis für die Pflegetext-Skripte: Pflanzabstand, artspezifische Verbote
// und die Nachprüfung der erzeugten Texte. Liegt bewusst in einem eigenen Modul, damit
// Erst- und Nachbesserungslauf garantiert dieselben Regeln benutzen.
const { gattung } = require('./pflanzen-giftigkeit');

// ── Pflanzabstand: gerechnet, nicht generiert ────────────────────────────────
// Grundregel des Staudengebrauchs: gesetzt wird auf die Breite, die die Pflanze im Alter
// erreicht — dann schließt der Bestand, ohne dass sich die Horste erdrücken. Ausläufertreiber
// werden enger gesetzt, weil sie die Lücken selbst schließen sollen.
// Arten, die sich über Ausläufer nicht nur ausbreiten, sondern verdrängen — dort ist enges
// Setzen kein Vorteil, sondern der Anfang des Problems.
const WUCHERND = /^(Matteuccia|Petasites|Aegopodium|Physalis|Houttuynia|Fallopia|Reynoutria|Macleaya|Persicaria|Lysimachia clethroides|Symphytum|Rudbeckia laciniata|Helianthus tuberosus|Phalaris|Glyceria|Phragmites)/;

function pflanzabstandRechnen(p) {
  const breiteRoh = Number(p.breite_cm_max) || Math.round((Number(p.hoehe_cm_max) || 50) * 0.6);
  const wuchs = String(p.wuchs || '').toLowerCase();
  const wuchernd = WUCHERND.test(String(p.name_botanisch || ''));
  const laeufer = wuchs.includes('ausläufer');
  const faktor = (laeufer && !wuchernd) ? 0.7 : 1;
  const roh = Math.round(breiteRoh * faktor);
  const mitte = Math.min(100, Math.max(15, roh));
  // Untergrenze hat gegriffen: dann stimmt die Begründung "entspricht der Endbreite" nicht mehr.
  const untergrenzeAktiv = roh < 15;
  const rund = (x) => Math.max(5, Math.round(x / 5) * 5);
  const von = rund(mitte * 0.85);
  // Bei kleinen Werten fallen beide Enden auf dieselbe Stufe ("15-15 cm") — dann eine Stufe spreizen.
  const bis = Math.max(rund(mitte * 1.15), von + 5);
  // Stückzahl aus der Mitte der AUSGEGEBENEN Spanne, nicht aus dem Rohwert — sonst passen
  // Spanne und Stückzahl nicht zusammen (15-20 cm wurden als 44/m² statt 33/m² ausgewiesen).
  const spannenMitte = (von + bis) / 2;
  const proQm = Math.max(1, Math.round(10000 / (spannenMitte * spannenMitte)));
  let zusatz;
  if (wuchernd) {
    zusatz = ' Die Pflanze breitet sich über Ausläufer stark aus und überwächst Nachbarn — großzügig setzen und die Ausbreitung im Auge behalten oder mit einer Wurzelsperre begrenzen.';
  } else if (laeufer) {
    zusatz = ' Etwas enger als die Endbreite, damit die Fläche schneller schließt — die Pflanze rückt über Ausläufer nach.';
  } else if (untergrenzeAktiv) {
    zusatz = ' Die Pflanze bleibt schmaler, wird aber in Gruppen gesetzt — enger als dieser Abstand geht die Wirkung verloren.';
  } else {
    zusatz = ' Das entspricht der Breite, die die Pflanze im Alter erreicht.';
  }
  return `${von}-${bis} cm (etwa ${proQm} ${proQm === 1 ? 'Pflanze' : 'Pflanzen'} pro m²).${zusatz}`;
}

// ── Artspezifische Verbote für den Rückschnitt ───────────────────────────────
// Gattungen, die nach einem Schnitt NICHT nachblühen oder denen ein Sommerschnitt schadet.
const NICHT_REMONTIEREND = new Set([
  'Paeonia', 'Baptisia', 'Thalictrum', 'Filipendula', 'Sanguisorba', 'Actaea', 'Cimicifuga',
  'Aruncus', 'Dictamnus', 'Gentiana', 'Trollius', 'Polygonatum', 'Convallaria', 'Hosta',
  'Rodgersia', 'Astilbe', 'Eryngium', 'Echinops', 'Acanthus',
]);
// Geophyten und Arten, deren Laub einziehen muss — dort ist jeder Schnitt vor dem Vergilben falsch.
const LAUB_EINZIEHEN = new Set([
  'Colchicum', 'Narcissus', 'Galanthus', 'Scilla', 'Hyacinthus', 'Tulipa', 'Allium',
  'Crocus', 'Cyclamen', 'Eranthis', 'Fritillaria', 'Camassia', 'Muscari', 'Lilium',
]);
const REMONTIER_FLOSKEL = /(zweite[nrs]?\s+Bl(ü|ue)te|erneute[nrs]?\s+Bl(ü|ue)te|Nachbl(ü|ue)te|bl(ü|uh)t\s+(dann\s+)?(ein\s+)?(zweites|nochmal|erneut))/i;

// Einzelfälle aus der Fachprüfung, die keine Gattungsregel abdeckt.
const SONDERFAELLE = {
  'Carex testacea': [
    'Diese Segge ist immergrün und nur bedingt winterhart (Neuseeland, etwa -12 bis -15 °C). Kein bodennaher Frühjahrsschnitt — nur auskämmen. In rauen Lagen Winterschutz empfehlen.',
  ],
  'Calla palustris': [
    'Standort ist die Flachwasserzone eines Teichs, nicht "feuchter Boden". Nicht düngen — Nährstoffeintrag kippt das Gewässer.',
  ],
};

function verboteFuer(p) {
  const g = gattung(p.name_botanisch);
  const v = [];
  const art = String(p.name_botanisch || '').split(/\s+/).slice(0, 2).join(' ');
  if (SONDERFAELLE[art]) v.push(...SONDERFAELLE[art]);
  // Immergrün ist artscharf, nicht gattungsweit: Carex grayi und C. muskingumensis sind
  // sommergrün, die erste Fassung dieser Regel hat ihnen die Falschbehauptung "da sie
  // immergrün ist" in die Fehlerliste geschrieben.
  const SOMMERGRUEN = /^(Carex grayi|Carex muskingumensis|Carex pendula|Carex elata|Carex acutiformis)/;
  const immergruenGattung = /^(Carex|Luzula|Festuca|Helleborus|Bergenia|Epimedium|Heuchera|Tiarella|Vinca)$/.test(g);
  if (immergruenGattung && !SOMMERGRUEN.test(String(p.name_botanisch || ''))) {
    v.push('Die Pflanze ist immergrün bzw. wintergrün: kein bodennaher Rückschnitt, nur altes Laub entfernen bzw. auskämmen.');
  }
  // Halbsträucher sind KEIN Fall für "nicht schneiden" — im Gegenteil, der jährliche Schnitt
  // ins junge Holz hält sie überhaupt erst am Leben.
  if (/^(Lavandula|Santolina|Perovskia|Salvia officinalis|Helianthemum|Caryopteris|Thymus|Hyssopus)$/.test(g)) {
    v.push('Halbstrauch: Ein jährlicher Rückschnitt ist notwendig, sonst verkahlt die Pflanze von innen. Geschnitten wird ins junge Holz, NIE ins alte, verholzte — daraus treibt sie nicht wieder aus.');
  }
  if (WUCHERND.test(String(p.name_botanisch || ''))) {
    v.push('Diese Art breitet sich über unterirdische Ausläufer stark aus und verdrängt Nachbarn. Benenne das deutlich. Ein oberirdischer Rückschnitt stoppt Rhizome NICHT — behaupte das nicht.');
  }
  if (/selbstsäend/.test(String(p.wuchs || '').toLowerCase())) {
    v.push('Die Pflanze versamt sich. Achte auf die Wirkungsrichtung: Wer die Blütenstände abschneidet, VERHINDERT die Selbstaussaat. Wer Aussaat will, lässt sie stehen.');
  }
  if (NICHT_REMONTIEREND.has(g)) {
    v.push(`${p.name_deutsch} blüht nach einem Rückschnitt NICHT erneut. Behaupte keine zweite Blüte und keinen "Anreiz für neue Blüten".`);
  }
  if (g === 'Paeonia') {
    v.push('Das Laub der Pfingstrose muss bis zum Vergilben stehen bleiben — ein Sommerschnitt kostet die Blüte des Folgejahres. Rückschnitt erst im Spätherbst.');
  }
  if (LAUB_EINZIEHEN.has(g)) {
    v.push(`Es handelt sich um einen Geophyten: Das Laub muss vollständig einziehen und vergilben, bevor es entfernt wird. Beschreibe den Laubzyklus korrekt zur angegebenen Blütezeit.`);
  }
  if (g === 'Colchicum') {
    v.push('Die Herbstzeitlose blüht im Herbst BLATTLOS; die Blätter erscheinen erst im folgenden Frühjahr und ziehen im Frühsommer ein. Formuliere den Rückschnitt entsprechend.');
  }
  const boden = String(p.boden || '').toLowerCase();
  const mager = /mager|sandig|durchlässig|kies|steinig/.test(boden);
  if (mager || ['Baptisia', 'Lupinus', 'Galega', 'Coronilla'].includes(g)) {
    v.push('Diese Pflanze braucht KEINE regelmäßige Düngung (Magerkeitszeiger bzw. Leguminose mit eigener Stickstoffversorgung) — empfiehl höchstens Kompost bei Bedarf und warne eher vor Überdüngung.');
  }
  const feucht = String(p.feuchtigkeit || '').toLowerCase();
  if (/nass|wasser|sumpf|teich/.test(feucht)) {
    v.push('Standort ist Nässe- bzw. Wasserbereich: Mineraldünger ist dort tabu, er belastet das Gewässer.');
  }
  return v;
}

const satzOk = (s) => typeof s === 'string' && s.trim().length >= 15 && s.trim().length <= 600;

// Nachprüfung: greift, was der Prompt allein nicht sicher verhindert.
function verstoesse(felder, p) {
  const g = gattung(p.name_botanisch);
  const raus = [];
  const rs = felder.rueckschnitt || '';
  // Die Floskel allein reicht nicht als Befund: Ein guter Text NENNT die zweite Blüte oft, um
  // sie zu verneinen ("bringt keine zweite Blüte", "eine zweite Blüte lässt sich damit nicht
  // auslösen"). Die erste Fassung dieser Prüfung hat drei solche korrekten Sätze als Verstoß
  // gemeldet. Deshalb wird jetzt der Satz um den Treffer herum auf Verneinung geprüft.
  if (NICHT_REMONTIEREND.has(g) || LAUB_EINZIEHEN.has(g)) {
    const text = rs + ' ' + (felder.tipp || '');
    for (const satz of text.split(/(?<=[.!?;:])\s+/)) {
      if (!REMONTIER_FLOSKEL.test(satz)) continue;
      const verneint = /\b(keine?[nrs]?|nicht|nie|niemals|ohne|statt|vergeblich|kein)\b/i.test(satz)
        || /\bnur einmal\b/i.test(satz);
      if (!verneint) { raus.push('behauptet eine zweite Blüte bei einer nicht remontierenden Art'); break; }
    }
  }
  if (/\d+\s*[-–]\s*\d+\s*cm/.test(rs + (felder.tipp || '') + (felder.pflanzzeit || ''))) {
    raus.push('nennt einen Zentimeter-Abstand, obwohl das Feld getrennt gepflegt wird');
  }
  // Wirkungsrichtung prüfen, nicht nur verbotene Handlungen. Die erste Fassung dieser Funktion
  // hat fünf Einträge durchgelassen, die behaupteten, ein Rückschnitt FÖRDERE die Selbstaussaat.
  const gesamt = rs + ' ' + (felder.tipp || '') + ' ' + (felder.fehler || []).join(' ');
  if (/(rückschnitt|schnitt|entfern\w*|abschneid\w*)[^.]{0,70}(fördert|begünstigt|ermöglicht|unterstützt)[^.]{0,40}(selbstaussaat|aussaat|versam)/i.test(gesamt)) {
    raus.push('behauptet, ein Rückschnitt fördere die Selbstaussaat — er verhindert sie');
  }
  if (/(rückschnitt|schnitt|zurückschneiden|entfern\w*)[^.]{0,70}(verhindert|stoppt|begrenzt|bremst)[^.]{0,40}(ausbreitung|ausläufer|rhizom|wuchern)/i.test(gesamt)) {
    raus.push('behauptet, ein oberirdischer Schnitt begrenze die Ausbreitung über Ausläufer');
  }
  // Nur der echte Widerspruch zählt: REGELMÄSSIG düngen und gleichzeitig vor Düngung warnen.
  // "Kompost bei Bedarf" neben "Überdüngung vermeiden" ist stimmige Praxis, kein Fehler —
  // die erste Fassung dieser Prüfung hat das als Verstoß gewertet und vier Pflanzen verworfen.
  const d = (felder.duengen || '').toLowerCase();
  const f = (felder.fehler || []).join(' ').toLowerCase();
  const empfiehltRegelmaessig = /(regelmäßig|jährlich|jedes frühjahr|im frühjahr).{0,40}(dünge|langzeitdünger)|(dünge|langzeitdünger).{0,40}(regelmäßig|jährlich|jedes frühjahr)/.test(d);
  // Neben echten Verneinungen zählen auch BEGRENZUNGEN als Entwarnung: "eine Gabe im Frühjahr
  // genügt" empfiehlt gerade keine wiederholte Düngung, sondern deckelt sie. Ohne diesen Teil
  // meldete die Prüfung einen Widerspruch, wo der Text sauber abgestuft war (einmal im
  // Frühjahr, Nachdüngung nur bei sichtbarem Mangel, zu viel Stickstoff schadet).
  const verneint = /nicht düngen|keine düngung|kein dünger|verzichte|nicht notwendig|nicht erforderlich|sparsam/.test(d)
    || /(genügt|genuegt|reicht (aus|völlig|vollig)?|mehr braucht|braucht (sie |er |es )?nicht mehr|einmal (im|pro) jahr|eine (einzige )?gabe)/.test(d);
  const warntDavor = /überdüng|zu viel dünger|übermäßige düngung|dünger schadet|nährstoffreiche[nrs]? böden? schaden/.test(f);
  if (empfiehltRegelmaessig && !verneint && warntDavor) raus.push('empfiehlt regelmäßige Düngung und warnt zugleich davor');
  return raus;
}


module.exports = { pflanzabstandRechnen, verboteFuer, verstoesse, satzOk,
  WUCHERND, NICHT_REMONTIEREND, LAUB_EINZIEHEN, SONDERFAELLE };
