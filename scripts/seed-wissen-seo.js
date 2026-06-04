// Ergänzt die Wissensdatenbank um SEO-relevante Themen basierend auf Google-Suchanfragen.
// node scripts/seed-wissen-seo.js

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const { OpenAI } = require('openai');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'stauden.db'));
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Themen abgeleitet aus tatsächlichen Google-Suchanfragen im Bereich Staudenplanung
const SEO_THEMEN = [
  // "Stauden für X" — Evergreen-Suchanfragen
  { titel: 'Stauden für den Schatten — die besten Arten für dunkle Beete', kategorie: 'Standorte', keyword: 'Stauden für Schatten', prompt: 'Umfassender Ratgeber: Welche Stauden eignen sich für schattige Beete? Vollschatten vs. Halbschatten unterscheiden, Ursachen von Schatten (Haus, Bäume), Top-15 Schattenstauden mit Pflanzempfehlungen, häufige Fehler. Lesern direkt nutzbare Tipps.' },
  { titel: 'Pflegeleichte Stauden für wenig Arbeit im Garten', kategorie: 'Praxis', keyword: 'pflegeleichte Stauden', prompt: 'Ratgeber für Gartenbesitzer die wenig Zeit haben: Was macht eine Staude pflegeleicht? Top-15 wirklich pflegeleichte Stauden für Sonne und Schatten. Warum Bodendecker und Mulch den Arbeitsaufwand halbieren. Einmal-pflanzen-immer-blühen.' },
  { titel: 'Stauden für den Vorgarten — Ideen und Bepflanzungsplan', kategorie: 'Gestaltung', keyword: 'Stauden Vorgarten', prompt: 'Gestaltungstipps für Vorgartenbeete mit Stauden: Besonderheiten des Vorgartens (Straßenrand, Beobachtung, evtl. Nordseitig), empfohlene Pflanzen, ganzjährige Attraktivität, Straßenstauden für Hitze und Trockenheit. Konkrete Kombinationsvorschläge.' },
  { titel: 'Stauden die den ganzen Sommer blühen', kategorie: 'Gestaltung', keyword: 'Stauden die lange blühen', prompt: 'Welche Stauden blühen besonders lang (8-16 Wochen)? Top-Langblüher von Mai bis Oktober. Wie kombiniert man Stauden für einen durchgängigen Blühaspekt von Frühjahr bis Herbst? Rückschnitt-Trick für zweite Blüte.' },
  { titel: 'Stauden für trockene, sonnige Standorte — Trockenheit tolerant', kategorie: 'Standorte', keyword: 'Stauden trocken Sonne', prompt: 'Ratgeber für trockene Sonnenstaudenbeete: Ursachen von Trockenheit, Bodenverbesserung, Mulchstrategien, Top-20 Stauden für Trockenheit (Sedum, Stachys, Salvia, Nepeta etc.), Kiesgärten als Lösung. Klimawandel-resiliente Pflanzen.' },
  { titel: 'Bodendecker Stauden — flächendeckende Pflanzen für alle Standorte', kategorie: 'Standorte', keyword: 'Bodendecker Stauden', prompt: 'Ratgeber Bodendecker: Welche Stauden decken Flächen ab und verdrängen Unkraut? Bodendecker für Sonne, Halbschatten und Schatten. Pflanzabstände, Eingewöhnungszeit, kombinieren mit größeren Stauden. Top-15 Bodendecker.' },
  { titel: 'Staudenbeet anlegen — Schritt für Schritt Anleitung', kategorie: 'Praxis', keyword: 'Staudenbeet anlegen', prompt: 'Komplette Anleitung zum Anlegen eines neuen Staudenbeets: Standort wählen, Boden vorbereiten, Unkraut beseitigen, Pflanzenauswahl, Pflanzung, erste Pflege. Zeitplan (wann anfangen?), Kosten und typische Fehler.' },
  { titel: 'Stauden pflanzen — wann ist der beste Zeitpunkt?', kategorie: 'Praxis', keyword: 'Stauden pflanzen wann', prompt: 'Wann ist der optimale Zeitpunkt Stauden zu pflanzen? Frühjahr vs. Herbst, Vor- und Nachteile beider Pflanzzeiten, containerware vs. Ballen, Bodentemperatur als Faktor. Spezielle Empfehlungen für verschiedene Staudengruppen.' },
  { titel: 'Stauden für Bienen und Insekten — insektenfreundlicher Garten', kategorie: 'Oekologie', keyword: 'Stauden für Bienen', prompt: 'Ratgeber für bienenfreundliche Staudengärten: Warum gefüllte Blüten oft wertlos sind, welche Stauden besonders viel Nektar geben, Top-20 Bienenweide-Stauden für Deutschland, Blühzeitraum über die Saison planen, Bedeutung heimischer Arten.' },
  { titel: 'Stauden schneiden — wann und wie richtig schneiden?', kategorie: 'Praxis', keyword: 'Stauden schneiden', prompt: 'Praxisratgeber Staudenschnitt: Frühjahrsschnitt (wann und wie weit?), Sommerschnitt für zweite Blüte, Herbst: was stehen lassen (Vogelschutz, Winteraspekt), Überwinterungsschnitt. Spezielle Schnittregeln für wichtige Gattungen.' },
  { titel: 'Stauden kombinieren — so entstehen schöne Beete', kategorie: 'Kombinationen', keyword: 'Stauden kombinieren', prompt: 'Anleitung zum Kombinieren von Stauden: Grundprinzipien (Höhe, Blühzeit, Textur, Farbe), das 3er-Prinzip (Leit-Begleit-Füller), 8 konkrete fertige Kombinationsrezepte für verschiedene Standorte und Stile. Häufige Fehler vermeiden.' },
  { titel: 'Winterharte Stauden für Deutschland — was überlebt den Winter?', kategorie: 'Praxis', keyword: 'winterharte Stauden', prompt: 'Ratgeber Winterhärte: Was bedeuten USDA-Zonen für Deutschland? Welche Stauden sind zuverlässig winterhart? Stauden die Winterschutz brauchen vs. vollständig winterharte Arten. Top-20 absolut winterharte Stauden für alle Standorte.' },
  { titel: 'Bepflanzungsplan Garten kostenlos erstellen — so geht\'s', kategorie: 'Grundprinzipien', keyword: 'Bepflanzungsplan erstellen kostenlos', prompt: 'Anleitung zum selbst Erstellen eines Bepflanzungsplans: Standort analysieren, Bestandsaufnahme, Flächenmessung, Pflanzenliste, Zeichnung/Skizze. Welche Informationen brauche ich? Tools und Methoden. Wann lohnt ein Fachplaner? Vorteile eines KI-Bepflanzungsplaners.' },
  { titel: 'Stauden kaufen — worauf beim Kauf achten?', kategorie: 'Praxis', keyword: 'Stauden kaufen', prompt: 'Kaufratgeber Stauden: Online-Kauf vs. Baumschule vs. Gartencenter — Vor- und Nachteile. Auf was beim Kauf achten (Qualitätsmerkmale, Topfgröße, Zeitpunkt), Containerware vs. Ballen, gesunde Pflanze erkennen. Beste Quellen für seltene Stauden.' },
  { titel: 'Stauden für Nordseite und Nordhang — dunkle Standorte bepflanzen', kategorie: 'Standorte', keyword: 'Stauden Nordseite', prompt: 'Spezialratgeber für Nordlagen: Besonderheiten von Nordfassade und Nordhang (Licht, Kälte, Trockenheit trotz Schatten), Top-15 Stauden speziell für Nordseiten, Kombination mit Gehölzen, Boden verbessern, realistische Erwartungen.' },
];

const heute = new Date().toISOString().split('T')[0];

async function generateThema(thema) {
  const existing = db.prepare("SELECT COUNT(*) as n FROM wissen WHERE titel = ?").get(thema.titel);
  if (existing.n > 0) { console.log(`  [skip] "${thema.titel}"`); return false; }

  console.log(`  Generiere: "${thema.titel}"...`);

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content: 'Du bist ein erfahrener Staudenexperte und SEO-Texter. Schreibe informativen, praxisorientierten Content für Gartenbesitzer. Zielgruppe: Hobbygärtner in Deutschland. Natürlicher Schreibstil, konkrete Pflanzennamen (deutsch und botanisch), direkt umsetzbare Tipps.'
      },
      {
        role: 'user',
        content: `Schreibe einen Ratgeber-Artikel von 400-500 Wörtern zum Thema:\n\n"${thema.titel}"\n\nZiel-Keyword: "${thema.keyword}"\n\nInhalt: ${thema.prompt}\n\nFormat: 3-4 natürliche Textabsätze ohne Überschriften oder Markdown. Keyword natürlich 2-3x einbauen. Konkret und hilfreich.`
      }
    ],
    temperature: 0.5
  });

  const inhalt = completion.choices[0].message.content.trim();
  db.prepare(`INSERT INTO wissen (titel, inhalt, kategorie, quelle, datum) VALUES (?,?,?,?,?)`)
    .run(thema.titel, inhalt, thema.kategorie, 'SEO-Ratgeber GPT-4o', heute);
  return true;
}

(async () => {
  console.log('=== SEO-Wissensthemen generieren ===');
  let vorher;
  try { vorher = db.prepare('SELECT COUNT(*) as n FROM wissen').get().n; } catch { vorher = 0; }
  console.log(`Vorher: ${vorher} Einträge\n`);

  let neu = 0;
  for (const thema of SEO_THEMEN) {
    if (await generateThema(thema)) neu++;
    await new Promise(r => setTimeout(r, 600));
  }

  const nachher = db.prepare('SELECT COUNT(*) as n FROM wissen').get().n;
  console.log(`\n=== +${neu} neue SEO-Themen, ${nachher} Einträge gesamt ===`);
  db.close();
})().catch(console.error);
