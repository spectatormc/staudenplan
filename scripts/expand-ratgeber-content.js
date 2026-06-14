// Erweitert dünne Ratgeber-Artikel für besseres Google-Ranking
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '..', 'stauden.db'));

const updates = [
  {
    titel: 'Teichrand und Feuchtbeet: Gestaltung am Wasser',
    inhalt: `Bewährte Kombination für dauerhaft feuchte bis nasse Standorte. Zonierung vom Wasser nach außen: Zone 1 (bis 20 cm Wassertiefe): Iris pseudacorus (Sumpfschwertlilie, 100 cm, gelb), Pontederia cordata (Hechtkraut, 60 cm, blau). Zone 2 (Teichrand, Boden feucht-nass): Caltha palustris (Sumpfdotterblume, 30 cm, gelb, sehr früh), Lysimachia nummularia (Pfennigkraut, Bodendecker, 5 cm). Zone 3 (Sumpfbeet, gelegentlich nass): Lythrum salicaria (Blutweiderich, 120 cm, rosa-rot), Filipendula ulmaria (Mädesüß, 100 cm, weiß, duftend), Iris sibirica (Sibirische Schwertlilie, 80 cm, blau-violett).

Warum diese Kombination funktioniert: Die gestaffelte Zonierung ist das Herzstück dieser Bepflanzung. Jede Pflanze bekommt genau den Wasserstand, den sie braucht. Die Sumpfschwertlilie verankert das Design mit ihrer klaren Vertikalen und ihren leuchtend gelben Blüten im Mai, während Pontederia cordata mit blauem Sommerflor überbrückt. Am eigentlichen Uferrand sorgt die Sumpfdotterblume bereits im März für die ersten Farbtupfer – als eine der frühesten Wasserpflanzen überhaupt.

Saisonale Abfolge: März–April blüht Caltha palustris als erste mit knalligem Gelb. Mai–Juni zeigen Iris pseudacorus und Iris sibirica ein harmonisches Gelb-Blau-Spiel. Juli–August bringen Lythrum salicaria und Filipendula ulmaria Höhe und Fülle in die Pflanzung. Filipendula duftet dabei intensiv nach Mandeln – ein besonderes Erlebnis an Sommerabenden am Teich. September schließt Pontederia cordata die Blütsaison mit blau-violetten Ähren ab.

Pflanzung und Pflege: Die Pflanzen werden am besten im Frühjahr oder Frühherbst gesetzt, wenn der Boden noch warm ist. Zone-1-Pflanzen direkt ins Wasser, Zone-2-Pflanzen in dauerfeuchten Uferbereich, Zone-3-Pflanzen in normalen Gartenboden, der nach starken Regenfällen feucht ist. Lythrum salicaria kann invasiv werden – nach der Blüte die Samenstände entfernen. Filipendula braucht keinen Rückschnitt im Herbst, die Struktur ist wertvoll für Insekten. Iris pseudacorus alle 4–5 Jahre teilen, wenn die Büschel zu dicht werden.

Diese Kombination zieht massenhaft Libellen, Frösche und Wasservögel an und schafft echte Naturerlebnisse direkt im eigenen Garten. Geeignet für Gartenteiche ab 2 m² Wasserfläche, Regenbeete und naturnahe Feuchtbereiche.`
  },
  {
    titel: 'Klassisches Schattenbeet: Hosta, Farn und Astilbe',
    inhalt: `Bewährteste Kombination für schattige Lagen. Struktur: Hosta sieboldiana 'Elegans' (80 cm, riesige blaugrüne Blätter) als Solitär, Hosta fortunei 'Aureomarginata' (60 cm, gelbrand). Blüte: Astilbe x arendsii in Rosa, Weiß und Rot (60–80 cm, blüht Hochsommer), Actaea simplex (Silberkerze, 120 cm, weiß, Herbst). Farnstruktur: Dryopteris filix-mas (Wurmfarn, 80 cm), Athyrium filix-femina (Frauenfarn, 60 cm, zarter).

Warum diese Kombination zeitlos ist: Hostas, Farne und Astilben sind seit Generationen das bewährteste Trio für den Schattengarten. Hostas liefern mächtige Blattstruktur, die in keiner anderen Pflanzenfamilie so ausgeprägt vorhanden ist. Die ledrigen, gerippten Blätter von Hosta sieboldiana 'Elegans' reflektieren selbst das schwächste Licht und lassen dunkle Gartenbereiche regelrecht aufleuchten. Farne ergänzen das Bild mit ihrer filigranen Textur, die einen direkten Kontrast zur fleischigen Hosta-Optik bildet.

Blütenabfolge im Schatten: Mai–Juni erscheinen die Hosta-Blütenrispen in Blassviolett – oft übersehen, aber angenehm duftend. Juli–August bringen Astilbe-Federbüschel in Rosa, Rot und Weiß die einzige intensive Blütenfülle in den Schattenbereich. September–Oktober schiebt Actaea simplex (Cimicifuga) lange weiße Kerzen in die Höhe – das stimmungsvolle Finale der Schattenstauden-Saison.

Texturen als Gestaltungsprinzip: Dieses Beet lebt von Texturgegensätzen. Grob und glatt (Hosta) gegen filigran und bewegt (Farn) gegen federig-leicht (Astilbe). Diese Kontraste auf kleinstem Raum machen das Beet interessanter als manche farbenprächtige Sonnenrabatte. Im Winter bleiben die Farne teilweise grün und Actaea-Fruchtstände stehen als elegante Silhouetten.

Standort und Pflege: Optimaler Standort ist Halbschatten bis tiefer Schatten, etwa unter Laubbäumen oder an der Nordseite des Hauses. Boden tiefgründig mit Kompost verbessern – Hostas sind Starkzehrer. Schneckenschutz für Hostas vorsehen, da sie als erste Anlaufstelle gelten. Astilben regelmäßig wässern und im Sommer nicht austrocknen lassen. Farne brauchen kaum Pflege; im Frühjahr altes Laub entfernen. Das Beet ist ideal für alle, die einen wartungsarmen aber attraktiven Schattengarten anlegen möchten.`
  }
];

const stmt = db.prepare('UPDATE wissen SET inhalt=? WHERE titel=?');
for (const u of updates) {
  const changes = stmt.run(u.inhalt, u.titel).changes;
  const len = u.inhalt.length;
  const words = u.inhalt.split(/\s+/).filter(w => w.length > 2).length;
  console.log(`${changes ? '✅' : '❌'} ${u.titel}: ${len} Zeichen, ~${words} Wörter`);
}

db.close();
