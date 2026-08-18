/*
 * Kuratierte Bündelung der Pflegefehler zu Themen.
 *
 * Die Pflanzentabelle führt 2090 Fehler-Nennungen in 909 verschiedenen Formulierungen. Viele
 * meinen dasselbe und schreiben es anders: „Staunässe", „Überwässerung", „Zu viel Wasser" und
 * „Übermäßiges Gießen kann zu Wurzelfäule führen" sind ein und derselbe Fehler — zusammen 255
 * Nennungen, einzeln unauffällig.
 *
 * BEWUSST EXAKTER TEXTVERGLEICH, KEINE MUSTERSUCHE. Ein erster Anlauf hat die Rückschnitt-Texte
 * über Schlagwörter sortiert und dabei das Sonnenauge unter „erst im Frühjahr schneiden"
 * einsortiert, obwohl sein Text „Nach der Blüte im Herbst zurückschneiden" sagt — das Wort
 * „Frühjahr" stand im Zweck („um den Neuaustrieb im Frühjahr zu fördern"), nicht im Zeitpunkt.
 * 21 Pflanzen trafen zwei sich widersprechende Regeln gleichzeitig. Eine falsch einsortierte
 * Pflegeanweisung ist eine Falschauskunft; deshalb wird hier nur zusammengefasst, was WÖRTLICH
 * übereinstimmt. Was nicht in der Liste steht, bleibt auf der Pflanzenseite und taucht hier
 * nicht auf.
 *
 * Die Zahlen auf der Seite entstehen aus dieser Zuordnung und sind damit nachzählbar.
 */

// Jede Zeile: exakte Varianten (case-insensitiv, Leerraum normalisiert) → ein Thema.
const THEMEN = [
  {
    id: 'zu-viel-wasser',
    titel: 'Zu viel Wasser',
    kurz: 'Der häufigste Fehler überhaupt — und der tödlichste.',
    erklaerung: 'Staunässe bringt mehr Stauden um als jeder Frost. Die Wurzeln ersticken im '
      + 'wassergesättigten Boden und faulen; die Pflanze sieht dabei zunächst welk aus, was viele '
      + 'zum Nachgießen verleitet. Wer im Zweifel ist, gräbt eine Handbreit tief: Fühlt sich die '
      + 'Erde dort noch feucht an, wird nicht gegossen.',
    varianten: [
      'Staunässe',
      'Überwässerung',
      'Zu viel Wasser',
      'Übermäßiges Gießen',
      'Zu häufiges Gießen kann zu Wurzelfäule führen.',
      'Übermäßiges Gießen kann zu Wurzelfäule führen.',
      'Staunässe vermeiden, da sie zu Wurzelfäule führen kann.',
      'Übermäßiges Gießen, das zu Wurzelfäule führen kann',
      'Zu häufiges Gießen',
      'Staunässe, die zu Wurzelfäule führen kann',
      'Zu viel Gießen',
    ],
  },
  {
    id: 'zu-dichter-boden',
    titel: 'Zu dichter Boden',
    kurz: 'Betrifft mehr Stauden als jede andere Standortfrage.',
    erklaerung: 'Schwerer, verdichteter Boden hält Wasser wie ein Schwamm — die Folge ist '
      + 'dieselbe wie beim Übergießen. Abhilfe schafft nicht Sand allein, sondern grober Sand '
      + 'zusammen mit organischem Material; reiner Sand in Lehm ergibt Beton. Bei anhaltend '
      + 'schwerem Boden ist ein leicht erhöhtes Beet die zuverlässigere Lösung.',
    varianten: [
      'Zu dichter Boden',
      'Zu schwerer Boden',
      'Verdichteter Boden',
      'Zu dichter, schwerer Boden',
    ],
  },
  {
    id: 'falscher-standort',
    titel: 'Zu wenig oder zu viel Licht',
    kurz: 'Eine Staude am falschen Platz wird nie gut, egal wie gut sie gepflegt wird.',
    erklaerung: 'Zu wenig Licht führt zu langen, weichen Trieben, die auseinanderfallen, und zu '
      + 'ausbleibender Blüte. Zu viel direkte Sonne verbrennt Schattenstauden die Blattränder. '
      + 'Beides lässt sich nicht wegpflegen — hier hilft nur Umsetzen.',
    varianten: [
      'Zu schattiger Standort',
      'Zu viel direkte Sonne',
      'Zu sonniger Standort',
      'Zu wenig Licht',
      'Falscher Standort',
      'Zu viel Sonne',
    ],
  },
  {
    id: 'zu-eng-gepflanzt',
    titel: 'Zu eng gepflanzt',
    kurz: 'Im ersten Jahr sieht es voll aus, im dritten drängt sich alles.',
    erklaerung: 'Stauden werden nach der Breite gesetzt, die sie im Alter erreichen, nicht nach '
      + 'der Topfgröße. Zu enger Stand nimmt der Pflanzung die Luft; Mehltau und Fäulnis folgen, '
      + 'und die schwächeren Arten verschwinden. Der Pflanzplaner rechnet den Abstand aus der '
      + 'Endbreite — genau dafür steht er dort.',
    varianten: [
      'Zu dichter Pflanzabstand',
      'Zu dichter Pflanzabstand, der zu schlechter Luftzirkulation führt',
      'Zu enger Pflanzabstand',
      'Zu dichte Pflanzung',
      'Zu dichter Pflanzabstand, der zu Schimmel führen kann',
    ],
  },
  {
    id: 'zu-trocken',
    titel: 'Zu trockener Standort',
    kurz: 'Das Gegenstück zur Staunässe — und fast ebenso häufig.',
    erklaerung: 'Nicht jede Staude verträgt einen Platz, an dem der Boden im Sommer durchtrocknet. '
      + 'Besonders unter flach wurzelnden Gehölzen herrscht Wurzeldruck: Der Baum nimmt das Wasser '
      + 'zuerst. Dort gehören Arten hin, die ausdrücklich damit zurechtkommen.',
    varianten: [
      'Zu trockener Standort',
      'Zu trockener Boden',
      'Trockenheit',
      'Zu wenig Wasser',
      'Austrocknen des Bodens',
    ],
  },
  {
    id: 'zu-tief-gepflanzt',
    titel: 'Zu tief gepflanzt',
    kurz: 'Ein Fehler beim Einpflanzen, den man ein Jahr später nicht mehr erkennt.',
    erklaerung: 'Der Wurzelhals gehört auf Bodenniveau. Sitzt er tiefer, fault die Basis; bei '
      + 'Zwiebeln und Knollen gilt umgekehrt eine Mindesttiefe, sonst frieren sie durch oder '
      + 'kippen um. Wer unsicher ist, pflanzt lieber eine Spur zu hoch — die Erde setzt sich '
      + 'ohnehin noch.',
    varianten: [
      'Zu tiefe Pflanzung',
      'Zu tiefes Pflanzen',
      'Zu flache Pflanzung',
    ],
  },
  {
    id: 'zu-viel-duenger',
    titel: 'Zu viel Dünger',
    kurz: 'Gut gemeint, und fast immer schädlich.',
    erklaerung: 'Die meisten Stauden brauchen keine Düngung; eine Kompostgabe im Frühjahr reicht. '
      + 'Zu viel Stickstoff treibt weiches, langes Gewebe, das umkippt, anfälliger für Pilze ist '
      + 'und schlechter durch den Winter kommt. Auf mageren Böden bleiben Pflanzungen standfester '
      + 'und blühen oft besser.',
    varianten: [
      'Überdüngung',
      'Zu viel Dünger',
      'Übermäßige Düngung',
      'Zu viel Düngung',
    ],
  },
];

const normal = t => String(t || '').trim().replace(/\s+/g, ' ').toLowerCase();

// Rückabbildung Variante → Thema, einmal aufgebaut.
const NACH_VARIANTE = new Map();
for (const t of THEMEN) for (const v of t.varianten) NACH_VARIANTE.set(normal(v), t.id);

/*
 * Ordnet die Fehler aller übergebenen Pflanzen den Themen zu.
 * Rückgabe je Thema: die Pflanzen, die es betrifft — nach deutschem Namen sortiert.
 */
function themenMitPflanzen(pflanzen) {
  const treffer = new Map(THEMEN.map(t => [t.id, []]));
  let genannt = 0, zugeordnet = 0;

  for (const p of pflanzen) {
    let il;
    try { il = JSON.parse(p.inhalt_lang || '{}'); } catch { continue; }
    const fehler = Array.isArray(il.fehler) ? il.fehler : [];
    const schonHier = new Set();          // eine Pflanze zählt je Thema nur einmal
    for (const f of fehler) {
      genannt++;
      const id = NACH_VARIANTE.get(normal(f));
      if (!id || schonHier.has(id)) continue;
      schonHier.add(id);
      zugeordnet++;
      treffer.get(id).push({ name_deutsch: p.name_deutsch, name_botanisch: p.name_botanisch });
    }
  }

  for (const liste of treffer.values()) liste.sort((a, b) => a.name_deutsch.localeCompare(b.name_deutsch, 'de'));

  return {
    themen: THEMEN.map(t => ({ ...t, pflanzen: treffer.get(t.id) })).sort((a, b) => b.pflanzen.length - a.pflanzen.length),
    genannt, zugeordnet,
  };
}

module.exports = { THEMEN, themenMitPflanzen, normal };
