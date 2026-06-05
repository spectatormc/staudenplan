// Fügt Fachartikel zur Staudenverwendung, Höhenstaffelung und Anordnung in die Wissen-DB ein.
// Ausfuehren: node scripts/seed-staudenverwendung.js

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'stauden.db'));

try { db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS wissen USING fts5(titel, inhalt, kategorie, quelle, datum)`); } catch {}

const INSERT = db.prepare(`INSERT INTO wissen (titel, inhalt, kategorie, quelle, datum) VALUES (?, ?, ?, ?, ?)`);

const HEUTE = new Date().toISOString().split('T')[0];

const artikel = [
  {
    titel: 'Höhenstaffelung im Staudenbeet — das wichtigste Gestaltungsprinzip',
    kategorie: 'Grundprinzipien',
    inhalt: `Die Höhenstaffelung ist das grundlegendste Prinzip der Staudenverwendung. Hohe Stauden (über 100 cm) gehören in den Hintergrund oder die Beetmitte, mittelhohe Arten (40–100 cm) in die mittlere Zone, und niedrige Stauden sowie Bodendecker (unter 40 cm) in den Vordergrund. Dieses Prinzip gilt sowohl für einseitig als auch für allseitig sichtbare Beete. Bei allseitig sichtbaren Beeten (Inselbeeten) stehen die höchsten Pflanzen in der Mitte, die Höhe nimmt nach außen ab. Die Staffelung schafft Tiefenwirkung, sorgt dafür dass alle Pflanzen sichtbar sind und keine von einer anderen verdeckt wird. Als Faustregel gilt: Die höchste Pflanze sollte nicht mehr als zwei Drittel der Beetbreite überschreiten. Typische Höhengruppen: Leitstauden >100 cm (Rittersporn, Echinacea, Phlox paniculata), Begleitstauden 50–100 cm (Salbei, Katzenminze, Geranium), Bodendecker <30 cm (Storchschnabel-Sorten, Elfenblume, Immergrün).`
  },
  {
    titel: 'Das Drei-Schichten-Prinzip: Leitstauden, Begleitstauden und Bodendecker',
    kategorie: 'Grundprinzipien',
    inhalt: `Professionelle Staudenpflanzungen folgen dem Drei-Schichten-Prinzip. Schicht 1 — Leitstauden (15–20% der Pflanzenzahl): Hohe, auffällige Arten die dem Beet Struktur und Charakter geben. Sie sind die "Stars" der Pflanzung. Beispiele: Rittersporn, Phlox, Echinacea, Helenium, Rudbeckia. Schicht 2 — Begleitstauden (50–60% der Pflanzenzahl): Mittelhohe Arten die die Leitstauden ergänzen, Lücken füllen und für einen harmonischen Übergang sorgen. Beispiele: Salbei, Katzenminze, Geranium, Astilbe, Heuchera. Schicht 3 — Bodendecker und Füllstauden (25–35% der Pflanzenzahl): Niedrige, flächig wachsende Arten die den Boden bedecken, Unkraut unterdrücken und die Fläche vollständig schließen. Beispiele: Storchschnabel-Niedrigformen, Elfenblume, Waldsteinie, Immergrün, Thymian, Frauenmantel. Dieses Prinzip gilt für alle Stilrichtungen — vom Naturgarten bis zur formalen Anlage.`
  },
  {
    titel: 'Strukturpflanzen und Solitärstauden als Blickfang',
    kategorie: 'Grundprinzipien',
    inhalt: `Strukturpflanzen verleihen dem Beet das ganze Jahr über Halt und Gerüst — auch wenn sie nicht blühen. Sie zeichnen sich durch markante Blattform, interessante Textur oder außergewöhnlichen Wuchs aus. Wichtige Strukturstauden: Hosta (Funkie) mit großen, glatten Blättern ideal für Schatten; Acanthus (Bärenklau) mit tief eingeschnittenen Blättern; Kniphofia (Fackellilie) mit grasartigen Blättern; Iris mit fächerförmigem Blattwerk; Gräser wie Calamagrostis oder Miscanthus. Solitärstauden werden als Einzelpflanze in Szene gesetzt: Pampasgras, große Hosta-Sorten, Rizinus oder Cardoon wirken als lebendige Skulpturen. Strukturpflanzen sollten 10–15% des Sortiments ausmachen. Im Winter bleibt ihr Gerüst oft erhalten und gibt dem Beet auch in der kahlen Jahreszeit Kontur.`
  },
  {
    titel: 'Kombinationsprinzipien: Harmonie und Kontrast gezielt einsetzen',
    kategorie: 'Kombinationen',
    inhalt: `Zwei grundlegende Kombinationsprinzipien bestimmen das Erscheinungsbild eines Staudenbeetes. Harmonie-Prinzip: Ähnliche Farben (Blau-Violett-Rosa, Gelb-Orange-Rot) oder ähnliche Blattformen erzeugen ruhige, einheitliche Wirkung. Weiß wirkt als Verbinder zwischen allen Farben. Kontrast-Prinzip: Gegensätzliche Farben (Gelb/Violett, Orange/Blau) und gegensätzliche Blattformen (rund/schmal, glatt/gefiedert) erzeugen Spannung und Lebendigkeit. Empfohlene Kombinationen: Blaue Salbei + Gelbe Goldkolben + Weißer Phlox; Rote Helenium + Blaue Katzenminze + Gelbe Rudbeckia; Violetter Storchschnabel + Rosa Astilbe + Weißer Fingerhut. Textur-Kontrast ist oft wirkungsvoller als Farb-Kontrast: feine Gräser neben großblättrigen Stauden, fedrige Blüten neben kompakten Blütenköpfen. Faustregel: Nicht mehr als 3–4 Hauptfarben pro Beet, sonst wirkt es unruhig.`
  },
  {
    titel: 'Blütenfolge planen: Frühjahr bis Herbst ohne Pause',
    kategorie: 'Grundprinzipien',
    inhalt: `Ein professionell geplantes Staudenbeet blüht von März bis November ohne Lücken. Frühjahr (März–April): Küchenschelle, Elfenblume, Bergenie, frühe Primeln, Lungenkraut. Frühsommer (Mai–Juni): Akelei, Pfingstrose, früher Storchschnabel, Salbei, Katzenminze, Iris. Hochsommer (Juli–August): Rittersporn, Phlox, Echinacea, Helenium, Rudbeckia, Fackellilie, Agastache. Spätsommer (September–Oktober): Herbst-Anemone, Helenium (Spätblüher), Aster, Sedum (Fetthenne), Persicaria. Beim Planen gilt: Für jeden Zeitraum mindestens 2–3 blühende Arten einplanen. Lücken entstehen meist im Juli (nach Frühsommerblühern, vor Hochsommerblühern) — hier helfen Katzenminze (Rückschnitt fördert Nachblüte), Taglilien und frühe Rudbeckia. Gräser und Strukturpflanzen überbrücken blütenarme Phasen mit attraktivem Laub.`
  },
  {
    titel: 'Farbgestaltung im Staudenbeet: Theorie und Praxis',
    kategorie: 'Gestaltung',
    inhalt: `Die Farbgestaltung folgt dem Farbkreis nach Itten. Monochrome Pflanzungen: Alle Töne einer Farbe (Weiß-Grau-Silber, Blau-Violett-Lila) wirken elegant und ruhig. Besonders beliebt: White Gardens (nach Vita Sackville-West in Sissinghurst). Analoge Pflanzungen: Benachbarte Farben im Kreis (Gelb-Orange-Rot oder Blau-Violett-Rosa) wirken warm und harmonisch. Komplementäre Pflanzungen: Gegenüberliegende Farben (Blau+Orange, Violett+Gelb) erzeugen maximale Spannung. Praxistipps: Warme Farben (Rot, Orange, Gelb) wirken vordrängend — im Vordergrund platzieren. Kühle Farben (Blau, Violett, Weiß) wirken zurückweichend — in der Tiefe einsetzen. Silbernes und grünes Laub (Stachys, Artemisia) verbindet alle Farben. Im großen Beet: Farbblöcke mit mindestens 5–7 Pflanzen der gleichen Art, nicht einzeln verstreuen.`
  },
  {
    titel: 'Lebensbereiche nach Hansen & Stahl: Stauden am richtigen Standort',
    kategorie: 'Standorte',
    inhalt: `Das Lebensbereichskonzept von Richard Hansen und Friedrich Stahl (1981) teilt Gartenstandorte nach natürlichen Habitaten ein und empfiehlt jeweils passende Stauden. Gehölz (Schatten/Halbschatten, feucht): Astilbe, Hosta, Rodgersia, Actaea, Farn-Arten. Gehölzrand (Halbschatten, wechselfeucht): Geranium, Akelei, Digitalis, Thalictrum, Polygonatum. Freifläche/Steppe (Sonne, trocken-normal): Salvia, Echinacea, Rudbeckia, Penstemon, Agastache, Stipa. Freifläche/Wiese (Sonne, frisch-feucht): Helenium, Persicaria, Filipendula, Veronicastrum, Sanguisorba. Steingarten (Sonne, sehr trocken, durchlässig): Sedum, Sempervivum, Dianthus, Geranium sanguineum, Thymus. Teichrand/Feuchtgebiet (Sonne/Halbschatten, feucht-nass): Iris pseudacorus, Caltha, Lysimachia, Lythrum. Wichtig: Pflanzen am falschen Lebensbereich sind pflegeintensiv und kurzlebig. Am richtigen Standort sind sie langlebig und pflegeleicht.`
  },
  {
    titel: 'Naturgarten: heimische Stauden richtig kombinieren',
    kategorie: 'Oekologie',
    inhalt: `Heimische Stauden bieten maximalen ökologischen Wert für Insekten, Vögel und Kleintiere. Besonders wertvoll für Bienen und Schmetterlinge: Echtes Johanniskraut (Hypericum perforatum), Wiesenknopf (Sanguisorba), Natternkopf (Echium), Wegwarte (Cichorium), Margerite (Leucanthemum), Wilde Karde (Dipsacus). Für Vögel (Samen und Früchte): Wilde Karde, Sonnenhut (Echinacea), Rudbeckia, Goldrute (Solidago). Gestaltungsprinzipien Naturgarten: Pflanzen in Gruppen von 5–9 Stück setzen (wirkt natürlich). Gräser als Leitpflanzen einsetzen (Molinia, Deschampsia, Sesleria). Blühende Strukturen im Winter stehen lassen (Futter für Vögel, Überwinterungsort für Insekten). Heimische Arten mischen mit naturnahen Kultursorten (z.B. Echinacea-Sorten, Rudbeckia-Hybriden) für längere Blütezeit. Mindestens 70% heimische Arten für maximalen Ökologiepunkt.`
  },
  {
    titel: 'Füllstauden und Bodendecker: Freiflächen nachhaltig schließen',
    kategorie: 'Praxis',
    inhalt: `Füllstauden und Bodendecker sind das Fundament einer pflegeleichten Pflanzung. Sie schließen den Boden, unterdrücken Unkraut und geben der Pflanzung Ruhe. Top-Bodendecker für Sonne: Geranium sanguineum (Blutroter Storchschnabel, 20–30 cm), Nepeta x faassenii (Katzenminze, 30–40 cm, duftend), Thymus (Thymian, 5–15 cm, aromatisch), Sedum (Fetthenne, 10–60 cm, für Trockenmauern), Waldsteinia (5–15 cm, immergrün). Top-Bodendecker für Schatten/Halbschatten: Epimedium (Elfenblume, 20–30 cm, sehr robust, auch trocken), Vinca minor (Kleines Immergrün, 10–20 cm), Alchemilla (Frauenmantel, 30–40 cm, auch in Sonne), Pachysandra (Ysander, 20–30 cm), Lamium (Goldnessel, 15–20 cm). Pflanzabstand Bodendecker: 6–9 Stück pro m², je nach Art. Im ersten Jahr wässern bis geschlossen, danach weitgehend pflegefrei. Kein Bodendecker auf sehr trockenen, sandigen Böden ohne Bewässerung — dort Kies-Mulch verwenden.`
  },
  {
    titel: 'Pflanzabstände und Stückzahlen: Flächen richtig berechnen',
    kategorie: 'Praxis',
    inhalt: `Richtige Pflanzabstände sind entscheidend für das Zusammenwachsen und den Pflegeaufwand. Kleine Stauden und Bodendecker (Höhe <30 cm): 6–9 Pflanzen pro m², Abstand 30–40 cm. Mittelgroße Stauden (30–80 cm): 4–6 Pflanzen pro m², Abstand 40–50 cm. Große Stauden (80–150 cm): 2–3 Pflanzen pro m², Abstand 60–80 cm. Sehr große Leitstauden (>150 cm): 1 Pflanze pro m², Abstand 80–120 cm. Faustregel für Stückzahlberechnung: (Beetfläche in m²) × (Pflanzen pro m²) = Gesamtstückzahl. Bei gemischten Pflanzungen: 60–70% der Fläche mit Begleitstauden und Bodendeckern planen, 20–25% mit mittelgroßen Stauden, 10–15% mit Leitstauden. Wichtig: Zu enger Abstand führt zu Konkurrenz und erhöhtem Pflegeaufwand. Zu weiter Abstand lässt Unkraut gedeihen. Im ersten Jahr Lücken mit Annuellen (einjährige Sommerblumen) füllen, bis die Stauden sich schließen.`
  },
  {
    titel: 'Gräser im Staudenbeet: Struktur, Bewegung und Winteraspekt',
    kategorie: 'Kombinationen',
    inhalt: `Ziergräser sind unverzichtbare Partner der Stauden. Sie bringen Bewegung (Windspiel), winterlichen Aspekt und fine Textur ins Beet. Gräser für Sonne, trocken: Stipa tenuissima (Mexikanisches Federgras, 40–60 cm, federleicht), Festuca glauca (Blau-Schwingel, 20–30 cm, stahlblau), Helictotrichon sempervirens (Blaustrahlhafer, 60–90 cm). Gräser für Sonne, normal-feucht: Calamagrostis x acutiflora (Reitgras, 120–150 cm, aufrecht, ideal als Leitgras), Pennisetum alopecuroides (Lampenputzergras, 60–80 cm, herbstliche Ähren). Gräser für Halbschatten: Hakonechloa macra (Japanisches Berggras, 40–60 cm, goldgelbherbst), Carex (Segge, viele Arten für feuchte Schattenlagen), Deschampsia cespitosa (Rasenschmiele). Kombinationspartner: Gräser harmonieren besonders gut mit Echinacea, Rudbeckia, Agastache, Phlox und Sedum. Rückschnitt: Immergrüne Gräser nur leicht im Frühjahr stutzen. Sommergrüne Gräser im Februar/März bodennah zurückschneiden.`
  },
  {
    titel: 'Schattenbeete planen: Artenauswahl für schwierige Standorte',
    kategorie: 'Standorte',
    inhalt: `Schattenbeete sind keine Problemzonen — mit der richtigen Artenwahl werden sie zu faszinierenden Lebensräumen. Vollschatten (unter 3 h Sonne): Hosta (Funkie, alle Größen, Schlüsselpflanze), Asarum (Haselwurz, immergrün, flach), Epimedium (Elfenblume, auch trocken-schattig), Dryopteris (Wurmfarn), Athyrium (Frauenfarn), Vinca minor. Halbschatten (3–5 h): Astilbe (Prachtspiere, liebt Feuchtigkeit), Geranium nodosum und phaeum, Polygonatum (Salomonssiegel), Tiarella, Heuchera (Purpurglöckchen, bunte Blätter), Digitalis (Fingerhut, selbstsäend). Wichtige Kombinationsprinzipien für Schatten: Blattkontraste sind wichtiger als Blüten (viele Schatten-Stauden blühen weiß oder zart). Große, glatte Blätter (Hosta) neben gefiederten Farnen für maximale Wirkung. Helle Blattfarben (gelbgrün, silbrig) leuchten im Schatten. Feuchtigkeit ist oft wichtiger als Licht — Schatten-Stauden mögen gleichmäßig feuchten Boden.`
  },
];

const vor = db.prepare('SELECT COUNT(*) as n FROM wissen').get().n;

for (const a of artikel) {
  // Doppelte vermeiden
  const exists = db.prepare('SELECT COUNT(*) as n FROM wissen WHERE titel = ?').get(a.titel).n;
  if (!exists) {
    INSERT.run(a.titel, a.inhalt, a.kategorie, 'Staudenplan-Redaktion', HEUTE);
    console.log(`✓ ${a.titel}`);
  } else {
    console.log(`- Bereits vorhanden: ${a.titel}`);
  }
}

const nach = db.prepare('SELECT COUNT(*) as n FROM wissen').get().n;
console.log(`\n=== Fertig: ${nach - vor} neue Artikel (${nach} gesamt) ===`);
db.close();
