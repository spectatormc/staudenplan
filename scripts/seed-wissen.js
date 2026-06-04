// Befüllt die wissen-FTS5-Tabelle mit ~25 Fachthemen über Staudenverwendung per GPT-4o.
// Ausfuehren: node scripts/seed-wissen.js
// Idempotent: prueft ob Thema bereits vorhanden.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const { OpenAI } = require('openai');
const fs = require('fs');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'stauden.db'));
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS wissen USING fts5(
    titel,
    inhalt,
    kategorie,
    quelle,
    datum
  );
  CREATE TABLE IF NOT EXISTS wissen_quellen (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT UNIQUE,
    titel TEXT,
    abgerufen_am TEXT DEFAULT (datetime('now')),
    eintraege_erstellt INTEGER DEFAULT 0
  );
`);

const THEMEN = [
  // Grundprinzipien
  { titel: 'Lebensbereiche der Stauden nach Hansen & Stahl', kategorie: 'Grundprinzipien', prompt: 'Erkläre das Konzept der "Lebensbereiche" nach Richard Hansen und Friedrich Stahl für die Staudenverwendung. Beschreibe die wichtigsten Lebensbereiche (Freifläche, Gehölzrand, Gehölz, Wasserrand, Wasser) und ihre Bedeutung für die Pflanzenauswahl. Praktische Hinweise für die Planung.' },
  { titel: 'Vegetationsschichten und Staudenbeet-Struktur', kategorie: 'Grundprinzipien', prompt: 'Erkläre das Prinzip der Vegetationsschichten im Staudenbeet: Leitpflanzen, Begleitpflanzen, Füllpflanzen und Bodendecker. Wie viel Prozent jeder Gruppe? Welche Funktion hat jede Schicht? Praktische Beispiele für klassische Kombinationen.' },
  { titel: 'Pflanzdichte und Stückzahlberechnung im Staudenbeet', kategorie: 'Grundprinzipien', prompt: 'Erkläre wie man die richtige Pflanzdichte für Staudenbeete berechnet. Flächendeckung nach Pflanzengröße, Daumenregeln für verschiedene Staudentypen (Bodendecker, mittelgroße Stauden, Strukturpflanzen). Tabelle mit Pflanzabständen und Stückzahlen pro m².' },
  { titel: 'Planungsprozess für ein Staudenbeet', kategorie: 'Grundprinzipien', prompt: 'Schritt-für-Schritt-Anleitung für die Planung eines Staudenbeetes: Standortanalyse, Stilwahl, Pflanzenliste erstellen, Flächenaufteilung, saisonale Abfolge planen. Typische Planungsfehler und wie man sie vermeidet.' },

  // Stile
  { titel: 'Naturnahe Staudenverwendung — Grundprinzipien', kategorie: 'Stilpraegend', prompt: 'Beschreibe die Prinzipien naturnaher Staudenverwendung in deutschen Privatgärten. Heimische Arten, naturnahe Kombinationen, ökologische Vernetzung. Welche Pflanzen eignen sich besonders? Wie unterscheidet sich ein naturnaher von einem konventionellen Staudenbeet?' },
  { titel: 'Bauerngarten — Klassische deutsche Tradition', kategorie: 'Stilpraegend', prompt: 'Der Bauerngarten als Gartenstil: Geschichte, typische Pflanzen, Gestaltungsprinzipien. Klassische Staudenkombinationen im Bauerngartenstil. Wie plant man einen modernen Bauerngarten mit traditionellen Elementen? Pfingstrosen, Rittersporn, Phlox, Malven.' },
  { titel: 'Moderne Staudenbeetgestaltung — Neues Deutsches Design', kategorie: 'Stilpraegend', prompt: 'Erkläre das Konzept des "Neuen Deutschen Designs" (Karl Foerster, Richard Hansen, Urs Walser, Cassian Schmidt). Strukturpflanzen und Gräser, Blütenstauden. Saisonale Abfolge, Winteraspekte. Unterschied zu englischem Cottage-Stil.' },
  { titel: 'Cottage-Garten und englischer Gartenstil', kategorie: 'Stilpraegend', prompt: 'Der englische Cottage-Garten: typische Merkmale, Pflanzenauswahl, Gestaltungsprinzipien. Welche Stauden sind typisch (Delphinien, Lupinen, Rosen, Geranien)? Wie schafft man dieses "üppige Chaos" mit Struktur? Anpassung für deutsche Gärten.' },

  // Standorte
  { titel: 'Sonnige trockene Staudenbeete und Kiesgärten', kategorie: 'Standorte', prompt: 'Planung und Bepflanzung von trockenen, sonnigen Staudenbeeten und Kiesgärten. Welche Stauden sind trockenresistent? Bodenvorbereitung bei trockenen Standorten, Kies als Mulch. Empfohlene Pflanzen: Sedum, Stachys, Artemisia, Lavandula, Salvia, Iris. Pflanzenkombinationen.' },
  { titel: 'Halbschattige Staudenbeete am Gehölzrand', kategorie: 'Standorte', prompt: 'Gestaltung halbschattiger Staudenbeete unter Bäumen und am Gehölzrand. Welche Pflanzen gedeihen im Halbschatten? Übergang von Sonne zu Schatten planen. Bewährt: Astilbe, Hosta, Rodgersia, Thalictrum, Brunnera, Geranium (halbschattige Arten).' },
  { titel: 'Schattenbeete unter Bäumen und Sträuchern', kategorie: 'Standorte', prompt: 'Pflanzenauswahl und Gestaltung für echte Schattenbereiche unter Bäumen. Welche Stauden vertragen tiefen Schatten? Herausforderungen (Wurzelkonkurrenz, Trockenheit). Hosta, Epimedium, Waldsteinia, Dryopteris, Polystichum, Omphalodes.' },
  { titel: 'Feuchte Standorte, Teichrand und Sumpfbeete', kategorie: 'Standorte', prompt: 'Pflanzenauswahl für dauerhaft feuchte oder wechselfeuchte Standorte. Teichufer, Regenbeete, natürliche Senken. Geeignete Stauden: Iris pseudacorus, Lythrum, Trollius, Primula japonica, Astilbe chinensis, Filipendula. Bodenanforderungen.' },

  // Gestaltung
  { titel: 'Farbgestaltung im Staudenbeet', kategorie: 'Gestaltung', prompt: 'Prinzipien der Farbgestaltung für Staudenbeete: Farbharmonien, Kontraste, Farbtemperaturen. Warme vs. kühle Farben, Weiß als Verbinder. Saisonale Farbwechsel planen. Konkrete Farbkombinationsbeispiele: Blau-Gelb, Rosa-Purpur-Weiß, Gelb-Orange-Rot.' },
  { titel: 'Höhenstaffelung und Tiefenwirkung', kategorie: 'Gestaltung', prompt: 'Wie staffelt man Stauden nach Höhe für ein attraktives Staudenbeet? Grundregel: niedrig vorne, hoch hinten. Aber auch Ausnahmen. Transparente hohe Pflanzen in der Mitte. Höhengruppen: unter 30cm, 30-70cm, 70-120cm, über 120cm. Beispielpflanzen pro Gruppe.' },
  { titel: 'Ganzjahres-Attraktivität und saisonale Abfolge', kategorie: 'Gestaltung', prompt: 'Wie plant man ein Staudenbeet für Attraktivität über alle 4 Jahreszeiten? Frühblüher, Sommerstauden, Herbstaspekte, Winterstruktur. Konkrete Pflanzenauswahl für jeden Aspekt. Überlappende Blühzeiten sicherstellen.' },
  { titel: 'Ziergräser als Staudenbegleiter', kategorie: 'Gestaltung', prompt: 'Die Rolle von Ziergräsern im modernen Staudenbeet. Welche Gräser passen zu welchen Stauden? Miscanthus, Pennisetum, Calamagrostis, Molinia, Panicum, Stipa. Sommergrüne vs. immergrüne Gräser. Strukturgebende Funktion im Winter.' },
  { titel: 'Winteraspekte und Struktur im Staudenbeet', kategorie: 'Gestaltung', prompt: 'Welche Stauden bieten interessante Winteraspekte durch Samenstand, Struktur oder Fruchtschmuck? Warum "unaufgeräumte" Beete besser für die Natur sind. Empfohlene Wintersteher: Sedum, Echinacea, Phlomis, Eryngium, Helenium, Gräser. Pflegeprinzip "Stehen lassen".' },

  // Oekologie
  { titel: 'Bienenweide-Stauden und Insektenförderung', kategorie: 'Oekologie', prompt: 'Welche Stauden sind besonders wertvoll für Bienen, Hummeln und andere Insekten? Unterschied zwischen gefüllten (wenig Nektar) und einfachen Blüten. Blühzeitraum planen für lückenlosen Nektarstrom. Top-15 Bienenweide-Stauden für deutschen Gärten.' },
  { titel: 'Heimische vs. gartenwürdige Exoten', kategorie: 'Oekologie', prompt: 'Wann sind heimische Stauden den Gartenpflanzen vorzuziehen? Ökologischer Wert heimischer Arten für die Tierwelt. Welche Gartenstauden (Neophyten) haben trotzdem hohen Insektenwert? Empfehlenswerte heimische Staudenarten für Privatgärten.' },
  { titel: 'Lebendige Böden und Bodenbiologie im Staudenbeet', kategorie: 'Oekologie', prompt: 'Wie fördern Staudenbeete die Bodengesundheit? Mulchen, Bodenbedeckung, Regenwurmförderung. Wichtigkeit des Bodenlebens für Pflanzenwachstum. Organische vs. mineralische Mulchmaterialien. Keine Bodenbearbeitung unter Stauden.' },

  // Praxis
  { titel: 'Bodenvorbereitung und Standortverbesserung', kategorie: 'Praxis', prompt: 'Schritt-für-Schritt-Anleitung zur Bodenvorbereitung für neue Staudenbeete. Bodenanalyse, pH-Wert, Strukturverbesserung. Kompost, Sand, Ton je nach Bodentyp. Unkrautbekämpfung vor dem Pflanzen. Wann ist welche Bodenverbesserung sinnvoll?' },
  { titel: 'Stauden richtig pflanzen — Zeitpunkt und Technik', kategorie: 'Praxis', prompt: 'Optimaler Pflanztermin für Stauden (Frühjahr vs. Herbst). Wie pflanzt man richtig? Einwässern, Pflanztiefe, Pflanzabstände. Eingewöhnungsphase und erste Pflege. Häufige Fehler beim Pflanzen und wie man sie vermeidet.' },
  { titel: 'Jahrespflege und Schnittregeln für Staudenbeete', kategorie: 'Praxis', prompt: 'Monat-für-Monat-Pflegeanleitung für Staudenbeete. Frühjahrsschnitt: wann und wie weit zurückschneiden? Sommerpflege: Rückschnitt nach der Blüte für neue Blüten. Herbst: was stehen lassen? Typische Pflegefehler und "lazy gardening" Tipps.' },
  { titel: 'Haeufige Planungs- und Pflanzfehler im Staudenbeet', kategorie: 'Praxis', prompt: 'Beschreibe die 10 häufigsten Fehler bei der Staudenplanung und -pflege. Falsche Standortwahl, zu enge Pflanzung, fehlende Struktur, einseitige Blühzeiten, invasive Arten, Wuchsstärke unterschätzt. Für jeden Fehler die Lösung.' },

  // Kombinationen
  { titel: 'Klassische Dreierkombinationen für Staudenbeete', kategorie: 'Kombinationen', prompt: 'Erkläre das Prinzip der "Dreierkombination" (Leit-, Begleit-, Füllpflanze) in der Staudenplanung. Gib 8-10 bewährte konkrete Dreierkombinationen für verschiedene Standorte (sonnig, halbschattig, etc.) und Stile. Mit Bild im Kopf beschreiben.' },
  { titel: 'Kontrastprinzip und Texturkombinationen', kategorie: 'Kombinationen', prompt: 'Wie setzt man Kontraste in Staudenbeeten ein? Form- und Texturkontraste (fein vs. grob, rund vs. aufrecht). Farbkontraste im Detail. Warum Kontraste das Beet lebendig machen. Beispiele für gelungene Kontrast-Kombinationen.' },
];

const heute = new Date().toISOString().split('T')[0];

async function generateThema(thema) {
  // Check if already exists
  const existing = db.prepare("SELECT COUNT(*) as n FROM wissen WHERE titel = ?").get(thema.titel);
  if (existing.n > 0) {
    console.log(`  [skip] "${thema.titel}" bereits vorhanden`);
    return false;
  }

  console.log(`  Generiere: "${thema.titel}"...`);

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content: 'Du bist ein erfahrener Staudenexperte und Gartenplaner aus Deutschland. Schreibe präzise, praxisorientierte Fachtexte für professionelle Gartenplaner und versierte Hobbygärtner. Deutsch, klar strukturiert, konkrete Pflanzenbeispiele.'
      },
      {
        role: 'user',
        content: `Schreibe einen strukturierten Fachtext von 350-500 Wörtern zum Thema:\n\n"${thema.titel}"\n\nInhalt: ${thema.prompt}\n\nFormat: fließender Text mit 2-3 Absätzen, konkrete Pflanzenbeispiele (deutsche und botanische Namen), praktische Hinweise. Keine Überschriften, kein Markdown.`
      }
    ],
    temperature: 0.4
  });

  const inhalt = completion.choices[0].message.content.trim();

  db.prepare(`
    INSERT INTO wissen (titel, inhalt, kategorie, quelle, datum)
    VALUES (?, ?, ?, ?, ?)
  `).run(thema.titel, inhalt, thema.kategorie, 'GPT-4o Expertenwissen', heute);

  return true;
}

async function main() {
  console.log('=== Wissensdatenbank befuellen ===');

  let vorher, erstellt = 0;
  try {
    vorher = db.prepare('SELECT COUNT(*) as n FROM wissen').get().n;
  } catch {
    vorher = 0;
  }
  console.log(`Vorher: ${vorher} Eintraege\n`);

  for (const thema of THEMEN) {
    const neu = await generateThema(thema);
    if (neu) erstellt++;
    await new Promise(r => setTimeout(r, 500));
  }

  const nachher = db.prepare('SELECT COUNT(*) as n FROM wissen').get().n;

  // Save topic list for reference
  fs.writeFileSync(
    path.join(__dirname, '..', 'data', 'wissen-themen.json'),
    JSON.stringify(THEMEN.map(t => ({ titel: t.titel, kategorie: t.kategorie })), null, 2)
  );

  console.log(`\n=== Fertig: ${erstellt} neue Eintraege, ${nachher} gesamt ===`);
  console.log('Gespeichert: data/wissen-themen.json');
  db.close();
}

main().catch(console.error);
