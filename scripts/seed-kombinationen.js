// Fügt 20 bewährte Pflanzenkombinationen als RAG-Wissensartikel ein.
// Ausfuehren: node scripts/seed-kombinationen.js

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '..', 'stauden.db'));

try { db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS wissen USING fts5(titel, inhalt, kategorie, quelle, datum)`); } catch {}

const INSERT = db.prepare(`INSERT INTO wissen (titel, inhalt, kategorie, quelle, datum) VALUES (?, ?, ?, ?, ?)`);
const HEUTE = new Date().toISOString().split('T')[0];

const artikel = [
  {
    titel: 'Klassische Herbst-Kombination: Piet Oudolf Präriecharakter',
    kategorie: 'Kombinationen',
    inhalt: `Die bekannteste Kombination aus dem Werk von Piet Oudolf für naturnahe Präriebeete: Calamagrostis x acutiflora (Reitgras, 120 cm) als aufrechtes Leitgras, kombiniert mit Echinacea purpurea (Sonnenhut, 80 cm) in Rosa/Purpur, Rudbeckia fulgida (Schwarzäugige Susanne, 70 cm) in Gelb, Helenium (Sonnenbraut, 80–100 cm) in Orange-Rot und Sedum telephium 'Herbstfreude' (60 cm) als Herbstakzent. Bodendecker: Nepeta x faassenii (Katzenminze). Diese Kombination blüht von Juli bis Oktober und behält auch im Winter schöne Samenstandbilder. Standort: Vollsonne, normal bis wechselfeucht. Das Reitgras gibt im Winter den Rahmen, die Blütenstandbilder der anderen verbleiben bis Frühjahr für Vögel und Insektenüberwinterung. Pflanzenzahlen für 10 m²: 3 Calamagrostis, 7 Echinacea, 7 Rudbeckia, 5 Helenium, 5 Sedum, 9 Nepeta.`
  },
  {
    titel: 'Weißer Garten: Harmonie in Weiß und Silber nach Sissinghurst',
    kategorie: 'Kombinationen',
    inhalt: `Inspiriert von Vita Sackville-Wests White Garden in Sissinghurst Castle. Kernartenauswahl: Phlox paniculata 'White Admiral' (90 cm) als Leitpflanze, Achillea ptarmica 'The Pearl' (60 cm), Astrantia major 'Alba' (60 cm), Lysimachia ephemerum (80 cm, weiße Kerzen), Digitalis purpurea 'Alba' (120 cm, selbstsäend), Anemone hybrida 'Honorine Jobert' (100 cm, Spätsommer). Silber-Elemente: Stachys byzantina (Woll-Ziest, 30 cm), Artemisia 'Powis Castle' (60 cm). Gräser: Stipa tenuissima (Mexikanisches Federgras, 50 cm). Kombination blüht Mai–Oktober mit weißen Tönen durch alle Saisons. Wichtig: Genug Kontrast durch dunkles Laub (Heuchera 'Palace Purple') oder Buchs-Einfassung. Wirkt besonders stark im Abendlicht. Standort: Halbschatten bis Sonne, frisch-normal.`
  },
  {
    titel: 'Feuerkombination: Rot, Orange und Gelb für Hochsommer',
    kategorie: 'Kombinationen',
    inhalt: `Warme Feuerpalette für maximale Wirkung im Juli-September. Leitpflanzen: Helenium 'Moerheim Beauty' (90 cm, braunrot), Kniphofia uvaria (Fackellilie, 100 cm, orange-gelb), Hemerocallis 'Stafford' (70 cm, dunkelrot). Begleiter: Rudbeckia 'Goldsturm' (60 cm, goldgelb), Achillea 'Paprika' (60 cm, rot-orange), Gaillardia x grandiflora (50 cm, gelb-rot zweifarbig). Gräser: Pennisetum alopecuroides 'Hameln' (60 cm, Lampenputzergras). Vorfrühjahr: Tulipa 'Ballerina' (orange-gelb) für Frühjahrsaspekt. Diese Kombination verlangt Vollsonne und normalen Boden. Helenium braucht im ersten Jahr regelmäßige Bewässerung. Die Fackellilie als Solitär pflanzen (1 Pflanze im Vordergrund), Helenium und Rudbeckia in Gruppen von 5–7 Stück.`
  },
  {
    titel: 'Romantischer Cottage-Garten: Pastelltöne in Rosa und Blau',
    kategorie: 'Kombinationen',
    inhalt: `Klassische englische Cottage-Garden Kombination. Leitpflanzen (Frühjahr-Frühsommer): Paeonia lactiflora (Pfingstrose, 80–100 cm, rosa/weiß), Delphinium elatum (Rittersporn, 150–200 cm, blau), Digitalis purpurea (Fingerhut, 120 cm, rosa). Sommer: Phlox paniculata (80–100 cm, rosa-weiß), Geranium x magnificum (50 cm, violett), Nepeta 'Six Hills Giant' (60 cm, blau-violett), Veronica spicata (60 cm, blau). Vordergrund/Bodendecker: Alchemilla mollis (Frauenmantel, 40 cm, gelbgrün — verbindet alle Farben), Viola cornuta (Hornveilchen, 20 cm). Herbst: Rosa-Astern. Diese Mischung braucht guten Boden, regelmäßige Düngung und Stützen für Rittersporn. Blüte: Mai–September. Der Frauenmantel als Bodendecker ist das Geheimnis — er verbindet durch sein gelbgrünes Laub alle anderen Farben.`
  },
  {
    titel: 'Blaues Staudenbeet: Blau, Violett und Weiß als Thema',
    kategorie: 'Kombinationen',
    inhalt: `Monochromes Themenbet in kühlen Tönen. Frühjahr: Brunnera macrophylla (Kaukasusvergissmeinnicht, 40 cm, hellblau), Pulmonaria (Lungenkraut, 30 cm, blau). Frühsommer: Salvia nemorosa 'Caradonna' (60 cm, dunkelviolett, aufrecht), Geranium 'Rozanne' (40 cm, blau, lange Blüte Mai–Oktober), Delphinium 'Summer Skies' (150 cm, hellblau). Sommer: Agastache 'Blue Fortune' (80 cm, lavendelblau), Veronicastrum virginicum (150 cm, zartweiß-hellblau), Phlox paniculata 'Blue Paradise' (80 cm, violett). Gräser: Festuca glauca 'Elijah Blue' (30 cm, stahlblau — perfekter Kontrast). Weiß als Aufheller: Achillea 'The Pearl', Digitalis 'Alba'. Silber-Bindeglied: Stachys byzantina. Diese Kombination wirkt besonders zur Abenddämmerung, wenn kühle Töne aufleuchten.`
  },
  {
    titel: 'Trocken-mediterrane Kombination für Kiesgarten und Steinflächen',
    kategorie: 'Kombinationen',
    inhalt: `Bewährteste Kombination für sehr trockene, sonnige Lagen. Leitpflanzen: Perovskia atriplicifolia (Blauraute, 120 cm, silbrig-blau), Salvia x sylvestris 'Mainacht' (50 cm, dunkelviolett). Begleiter: Nepeta x faassenii (Katzenminze, 40 cm, blau), Achillea 'Moonshine' (60 cm, schwefelgelb), Echinacea purpurea (Sonnenhut, 80 cm, violett), Sedum 'Herbstfreude' (60 cm). Niedrig: Stachys byzantina (Woll-Ziest, 30 cm), Festuca glauca (Blau-Schwingel, 25 cm), Thymus (Thymian, 5–15 cm, aromatisch, zwischen Steinen). Alle Arten vertragen Trockenheit, Hitze und magere Böden. Kein Dünger, gut drainierter Kiesboden. Rückschnitt Salbei und Katzenminze nach erster Blüte fördert Nachblüte. Perovskia erst im März bodennah zurückschneiden.`
  },
  {
    titel: 'Naturgarten Präriecharakter: Insektenhochburg Juli–Oktober',
    kategorie: 'Kombinationen',
    inhalt: `Maximale Biodiversität im Hochsommer. Leitpflanzen: Echinacea purpurea (Sonnenhut, 80 cm), Rudbeckia fulgida 'Goldsturm' (60 cm), Monarda didyma (Indianernessel, 80 cm, rot). Hohe Leitstauden: Vernonia arkansana (Eisenkraut, 150 cm, violett-purple), Sanguisorba officinalis (Wiesenknopf, 100 cm, dunkelrot). Begleiter: Agastache foeniculum (Duftnessel, 70 cm, blau-violett), Origanum vulgare (Oregano, 50 cm, rosa). Gräser: Calamagrostis x acutiflora, Panicum virgatum 'Shenandoah'. Bodendecker: Geranium sanguineum (20–30 cm). Alle Pflanzen sind außerordentlich wertvoll für Schmetterlinge, Bienen und Hummeln. Kein Rückschnitt bis März — Samenstandbilder für Vögel und Insektenüberwinterung. Standort: Vollsonne bis Halbschatten, normal bis wechselfeucht.`
  },
  {
    titel: 'Klassisches Schattenbeet: Hosta, Farn und Astilbe',
    kategorie: 'Kombinationen',
    inhalt: `Bewährteste Kombination für schattige Lagen. Struktur: Hosta sieboldiana 'Elegans' (80 cm, riesige blaugrüne Blätter) als Solitär, Hosta fortunei 'Aureomarginata' (60 cm, gelbrand). Blüte: Astilbe x arendsii in Rosa, Weiß und Rot (60–80 cm, blüht Hochsommer), Actaea simplex (Silberkerze, 120 cm, weiß, Herbst). Farnstruktur: Dryopteris filix-mas (Wurmfarn, 80 cm), Athyrium filix-femina (Frauenfarn, 60 cm). Bodendecker: Epimedium x perralchicum (Elfenblume, 30 cm, immergrün, auch trocken-schattig — das robusteste Schattensortiment), Pachysandra terminalis (20 cm, immergrün). Frühling: Digitalis purpurea (Fingerhut) als Selbstsäer. Wichtig: Astilbe braucht gleichmäßige Feuchtigkeit — in trockenen Sommern wässern. Hosta schützen vor Schnecken (Kaffeesatz oder Schneckenkorn).`
  },
  {
    titel: 'Teichrand und Feuchtbeet: Gestaltung am Wasser',
    kategorie: 'Kombinationen',
    inhalt: `Bewährte Kombination für dauerhaft feuchte bis nasse Standorte. Zonierung vom Wasser nach außen: Zone 1 (bis 20 cm Wassertiefe): Iris pseudacorus (Sumpfschwertlilie, 100 cm, gelb), Pontederia cordata (Hechtkraut, 60 cm, blau). Zone 2 (Teichrand, Boden feucht-nass): Caltha palustris (Sumpfdotterblume, 30 cm, gelb, sehr früh), Lysimachia nummularia (Pfennigkraut, Bodendecker, 5 cm). Zone 3 (Sumpfbeet, feucht): Astilbe chinensis (Chinesische Prachtspiere, 80 cm), Lythrum salicaria (Blutweiderich, 120 cm, purpur — sehr wertvoll für Bienen), Filipendula ulmaria (Mädesüß, 120 cm, weiß-duftend), Primula japonica (Japanische Primel, 50 cm, rosa-rot). Hinweis: Lysimachia nummularia und Mentha breiten sich stark aus — in kleinen Gärten bremsen. Lythrum ist sehr selbstsäend — verwelkte Blüten entfernen verhindert unkontrollierten Aufwuchs.`
  },
  {
    titel: 'Bienenbeet: Nektar und Pollen von März bis November',
    kategorie: 'Kombinationen',
    inhalt: `Speziell auf Bienen, Hummeln und andere Bestäuber optimierte Kombination. März–April: Pulmonaria officinalis (Lungenkraut, 30 cm, erstes Frühling-Futter), Bergenia cordifolia (Bergenie, 40 cm). Mai–Juni: Salvia nemorosa (Salbei, 50 cm, exzellente Bienenweide), Geranium pratense (Wiesengeranium, 60 cm). Juli–August: Agastache foeniculum (Duftnessel, 70 cm, Hummelmagnet), Echinops ritro (Kugeldistel, 80 cm, ein Top-Insektenbiotop), Monarda didyma (Indianernessel), Nepeta (Katzenminze). September–Oktober: Aster amellus (Bergaster, 50 cm, unverzichtbar als Herbst-Bienenweide), Helianthus (Sonnenauge, 150 cm), Sedum telephium (Fetthenne, 60 cm — oft bedeckt mit Hummeln). Bodendecker: Thymus serpyllum (Teppichthymian, 5 cm, zwischen Trittsteinplatten). Alle 10 Arten zusammen auf 12–15 m² ergeben eine Hochleistungs-Bienenweide das ganze Gartenjahr.`
  },
  {
    titel: 'Pflegeleichte Starkkombi: Robust und dauerhaft ohne viel Arbeit',
    kategorie: 'Kombinationen',
    inhalt: `Kombination für minimalste Pflege — alle Arten sind langlebig, robust und bilden keine invasiven Ausbreiter. Top-5 unkaputtbare Kombinationspartner: 1. Geranium sanguineum (Blutroter Storchschnabel, 30 cm) — blüht 8 Wochen, breitet sich gemächlich aus, kaum Pflege. 2. Nepeta x faassenii (Katzenminze, 40 cm) — nach Rückschnitt zweite Blüte, sehr trockenhart. 3. Sedum 'Herbstfreude' (60 cm) — kein Rückschnitt nötig, winterhart bis -40°C. 4. Pennisetum alopecuroides (Lampenputzergras, 60 cm) — strukturgebend, Herbstfarbe, einmal im März schneiden. 5. Echinacea purpurea (Sonnenhut, 80 cm) — langlebig, selbstsäend (positiv), ideal für Naturgarten. Dazu als Leitstaude: Calamagrostis x acutiflora (Reitgras, 130 cm) — standfest auch ohne Stützen. Diese 6 Arten auf 10 m² brauchen im Sommer praktisch keine Arbeit und sehen im Winter durch die Samenstandbilder gut aus.`
  },
  {
    titel: 'Frühjahrskombination: Blütenfolge März bis Mai',
    kategorie: 'Kombinationen',
    inhalt: `Speziell für maximale Frühjahrsblüte. März: Helleborus niger/orientalis (Christrose, 40 cm, weiß-rosa-purpur — beginnt im Februar), Pulmonaria (Lungenkraut, 30 cm, rosa zu blau). April: Bergenia (Bergenie, 40 cm, rosa-karmin), Brunnera macrophylla (Kaukasusvergissmeinnicht, 40 cm, himmelblau, großes silbriges Laub). Mai: Aquilegia (Akelei, 60–80 cm, in allen Farben, selbstsäend), Geranium x cantabrigiense (30 cm, rosa-weiß, Bodendecker), Thalictrum aquilegiifolium (Wiesenraute, 100 cm, rosa Federpusten), Trollius europaeus (Trollblume, 50 cm, gelb, feucht). Übergang zu Sommer: Salvia nemorosa (beginnt Ende Mai), Nepeta (beginnt Mai-Juni). Zwiebelbegleiter zwischen den Stauden: Tulpen für Farbakzente, Allium (Zierlauch) als Brücke zu Sommer. Wichtig: Christrose und Brunnera an halbschattige Position — Frühjahrspflanzen mögen keine pralle Mittagssonne.`
  },
  {
    titel: 'Hochsommer-Kombination Juli–August: Wenn andere Beete pause machen',
    kategorie: 'Kombinationen',
    inhalt: `Viele Beete haben im Hochsommer eine Blütelücke. Diese Kombination löst das Problem. Kernarten: Echinacea purpurea und pallida (Sonnenhut, 80 cm, Juli–September), Kniphofia (Fackellilie, 100 cm, Juli–August, orange-gelb-rot), Agastache 'Blue Fortune' (80 cm, Juli–September, blau-violett), Hemerocallis-Hybriden (Taglilien, 60–80 cm, Juli–August, alle Farben). Hintergrund: Thalictrum flavum (Gelbe Wiesenraute, 150 cm, zartes Laub), Veronicastrum virginicum (150 cm, weiße Kerzen). Kontrastgräser: Panicum virgatum (Rutenhirse, 150 cm, rötlich im Herbst). Wichtiger Tipp: Salvia nemorosa nach erster Blüte (Juni) zurückschneiden — blüht Anfang August wieder nach und überbrückt die Hochsommerlücke. Monarda (Indianernessel) Juli–August als Schmetterlingspflanze einplanen.`
  },
  {
    titel: 'Herbstkombination September–Oktober: Farben wie im Laubwald',
    kategorie: 'Kombinationen',
    inhalt: `Herbstbeete erfordern spezielle Planung. Leitpflanzen: Anemone hybrida (Herbstanemone, 80–120 cm, weiß-rosa — der König des Herbstbeetes, blüht 6 Wochen), Aster amellus und novi-belgii (Astern, 50–80 cm, lila-rosa-weiß), Helenium 'Rubinzwerg' oder 'Waltraut' (Spätblüher, 80 cm, orange-rot). Gräser im Herbst: Pennisetum alopecuroides 'Hameln' (kupferne Ähren), Panicum virgatum (rötliche Herbstfärbung), Molinia caerulea (goldgelb). Frühe Herbstfärber: Sedum 'Herbstfreude' (September, braunrot), Sanguisorba (Wiesenknopf, September). Wichtig: Herbstanemone verlangt 2–3 Jahre Anwachsen, breitet sich dann rhizomatös aus — genug Platz lassen (1 Pflanze auf 1 m²). Mit Gräsern zusammen im November nicht zurückschneiden — winterliche Silhouetten bis März erhalten.`
  },
  {
    titel: 'Gräserkombination: Gräser als Hauptdarsteller',
    kategorie: 'Kombinationen',
    inhalt: `Gräser-dominierte Pflanzung nach dem Prinzip Karl Foersters. Leitgräser: Calamagrostis x acutiflora 'Karl Foerster' (120–150 cm, aufrecht, beginnt Mai zu blühen — erstes Hochgras im Garten), Miscanthus sinensis (200–250 cm, großer Solitär, Herbstsilhouette). Mittelgräser: Pennisetum alopecuroides 'Hameln' (60–80 cm, Herbstfahnen), Deschampsia cespitosa 'Goldtau' (80 cm, goldschimmernd). Niedrigräser: Stipa tenuissima (40 cm, federleicht, im Wind), Festuca glauca (25 cm, stahlblau). Staudenbegleiter für Gräserkombination: Echinacea, Rudbeckia und Sedum ergänzen ohne zu dominieren. Prinzip: 60% Gräser, 40% Begleitstauden. Rückschnitt: Alle Gräser erst im Februar/März bodennah schneiden. Sommergrüne Gräser (Pennisetum, Panicum) brauchen Wärme zum Austreiben — nicht zu früh schneiden.`
  },
  {
    titel: 'Schmales Beet und Streifen: Linearplanung für Rabatte und Wege',
    kategorie: 'Gestaltung',
    inhalt: `Für schmale Beete (unter 80 cm Tiefe) gelten eigene Regeln. Maximale Pflanzenhöhe sollte das Doppelte der Beettiefe nicht überschreiten. Für 60 cm tiefe Beete: Maximale Höhe 120 cm (Calamagrostis als Leitgras ideal). Bewährte Kombinationen für schmale Beete: Lineare Pflanzung — Salvia nemorosa 'Caradonna' (60 cm, aufrecht, schmal) + Geranium 'Rozanne' als Bodendecker vorne, Allium sphaerocephalon hinten. Wiederholungsrhythmus: Gleiche Arten alle 2–3 m wiederholen (A-B-A-B-Schema) — bei schmalen Beeten besonders wichtig für Ruhe. Vermeiden: Breite, ausladende Arten wie Rudbeckia in großen Mengen. Bevorzugen: Aufrechte, kompakte Wuchsformen. Bodendecker für die Vorderkante: Thymus, Sedum spurium, Geranium sanguineum var. striatum (niedrige Form 15 cm).`
  },
  {
    titel: 'Inselbeete: Rundum sichtbare Bepflanzung von der Mitte nach außen',
    kategorie: 'Gestaltung',
    inhalt: `Inselbeete sind von allen Seiten sichtbar — die Höhenstaffelung geht von der Mitte nach außen. Zentrum (höchste Pflanzen): Miscanthus sinensis als Solitär ODER Veronicastrum virginicum (150 cm) + Verbena bonariensis (150 cm, selbstsäend, durchsichtig-luftig). Mittlere Zone: Echinacea, Phlox, Helenium (60–100 cm). Äußere Zone: Geranium, Sedum, Nepeta (30–60 cm). Vorderkante: Stachys byzantina, Festuca glauca (15–30 cm). Wichtig beim Inselbeet: Kein Zentrum aus einer einzigen großen Pflanze setzen — 3 versetzt gepflanzte Gräser oder Leitstauden wirken natürlicher als 1. Die durchsichtige Verbena bonariensis als Zentrumselement ist besonders wertvoll — man sieht durch sie hindurch, sie verdeckt nichts. Wegbreite um Inselbeet: Mindestens 60 cm für Pflege.`
  },
  {
    titel: 'Vogelfreundliches Beet: Samen, Früchte und Überwinterungsschutz',
    kategorie: 'Oekologie',
    inhalt: `Für maximalen Vogelwert werden Pflanzen mit anhaltenden Samenständen und Fruchtschmuck eingesetzt — Rückschnitt erst im März. Top-Arten für Vögel: Echinacea purpurea (Sonnenhut — Stieglitze fressen Samen im Winter, unbedingt stehen lassen), Rudbeckia (Schwarzäugige Susanne — Samen für Finken), Helianthus (Sonnenauge, 150 cm — Sonnenblumen-ähnliche Samen), Dipsacus fullonum (Wilde Karde, 180 cm, zweijährig — Stieglitz-Magnet), Solidago (Goldrute — viele Insekten überwintern darin, Vögel fressen diese). Heckenpflanzen als Ergänzung: Sambucus, Viburnum, Sorbus. Das Beet im Winter nicht aufräumen: Hohle Stiele bieten Wildbienenunterkünfte, Samenständer Nahrung für 20+ Vogelarten. Einzige Ausnahme: Gefährdete Nachbarpflanzen durch Selbstsäer (Digitalis, Alchemilla) rechtzeitig entfernen.`
  },
  {
    titel: 'Bewährte Dreier-Kombinationen: Die wichtigsten Trios der Staudenplanung',
    kategorie: 'Kombinationen',
    inhalt: `Klassische Pflanzen-Trios die seit Jahrzehnten in Praxisbüchern empfohlen werden. Trio 1 — Sonniger Sommer: Salvia nemorosa + Achillea 'Moonshine' + Geranium sanguineum. Trio 2 — Hochsommer Feuer: Helenium + Rudbeckia + Calamagrostis. Trio 3 — Halbschatten Frühling: Brunnera macrophylla + Astilbe + Hosta. Trio 4 — Naturgartencharakter: Echinacea + Agastache + Pennisetum. Trio 5 — Trockenstandort: Perovskia + Nepeta + Stachys byzantina. Trio 6 — Feuchtbeet: Astilbe + Rodgersia + Dryopteris (Farn). Trio 7 — Spätblüher: Anemone hybrida + Aster amellus + Sedum 'Herbstfreude'. Trio 8 — Weißer Garten: Phlox 'White Admiral' + Astrantia 'Alba' + Stachys byzantina. Diese Trios sind erprobt: Sie konkurrieren nicht miteinander (unterschiedliche Höhen und Wurzeltiefen), haben ähnliche Standortansprüche und harmonieren farblich und strukturell.`
  },
  {
    titel: 'Fehler vermeiden: Häufige Planungsfehler in Staudenbeeten',
    kategorie: 'Praxis',
    inhalt: `Die häufigsten Fehler in der Staudenplanung und wie man sie vermeidet. Fehler 1: Zu enge Pflanzung — Stauden brauchen Platz zum Ausreifen, Mindestabstand nach Endgröße planen. Fehler 2: Invasive Arten ohne Kontrolle — Mentha, Lysimachia, Solidago, Anemone hybrida in kleinen Beeten ohne Abgrenzung durch Rhizomsperre. Fehler 3: Zu viele Farben — nicht mehr als 3–4 Hauptfarben pro Beet, sonst unruhig. Fehler 4: Alle Pflanzen gleich hoch — fehlende Höhenstaffelung nimmt dem Beet die Tiefenwirkung. Fehler 5: Nur Sommerblüher — kein Frühjahrs- und Herbstaspekt. Fehler 6: Bodendecker vergessen — 30–40% der Fläche sollte Bodendecker bedecken, sonst Unkrautprobleme. Fehler 7: Falsche Bodenbearbeitung — Stauden mögen keinen frisch gedüngten Boden (Schneckenproblem), besser Kompost einarbeiten. Fehler 8: Gräser zu früh schneiden — erst März, sonst friert das Herz aus. Fehler 9: Einjährige statt Stauden — kurzfristig bunter, langfristig mehr Arbeit. Fehler 10: Standortanforderungen ignorieren — Hosta in Vollsonne, Lavendel im Schatten funktionieren nicht.`
  },
];

const vor = db.prepare('SELECT COUNT(*) as n FROM wissen').get().n;
let neu = 0;

for (const a of artikel) {
  const exists = db.prepare('SELECT COUNT(*) as n FROM wissen WHERE titel = ?').get(a.titel).n;
  if (!exists) {
    INSERT.run(a.titel, a.inhalt, a.kategorie, 'Staudenplan-Redaktion', HEUTE);
    console.log(`✓ ${a.titel}`);
    neu++;
  } else {
    console.log(`- Bereits vorhanden: ${a.titel}`);
  }
}

const nach = db.prepare('SELECT COUNT(*) as n FROM wissen').get().n;
console.log(`\n=== Fertig: ${neu} neue Artikel (${nach} gesamt) ===`);
db.close();
