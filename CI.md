# CI Runbook (Stauden)

## Standard (relaxed)
Use on every feature branch push:

1. npm ci
2. npm run ci:relaxed

This runs:
1. check:env (partial SMTP configuration is warning)

## Release Gate (strict)
Use before merge to main or production deploy:

1. npm ci
2. npm run ci:strict

This runs:
1. check:env:strict (partial SMTP configuration fails)

## Runtime Verification (recommended)
Run after backend changes:

1. npm run ci:smoke

This runs:
1. check:smoke (starts local server and checks key routes)
2. check:selbsttest (self-tests of the data checks and of the two rule modules
   `scripts/preis-spanne.js` and `scripts/plan-pruefen.js`; no database or pins required)

`check:smoke` ruft seit dem 23.09.2026 auch `/api/plan` fuer kleine Beete auf (1,0 / 1,5 /
2,0 m²) und prueft die Rollenabdeckung des Notplans. Zwei Dinge halten die Zusage
„laeuft ohne Produktionsdaten" trotzdem aufrecht:
* Der Lauf arbeitet auf einer KOPIE von `stauden.db` in einem Temp-Verzeichnis (`DB_PFAD`).
  Jeder `/api/plan`-Aufruf schreibt eine Zeile in `plan_statistik`; ohne Kopie landeten
  Testzeilen in der Produktionsstatistik.
* Fehlt `stauden.db` (frischer Runner) oder hat sie zu wenige Zeilen, meldet der Lauf
  `UEBERSPRUNGEN (keine Pflanzendaten)` mit Begruendung und laeuft weiter.

## Datenpruefungen (nur auf dem Server, `npm run ci:daten`)

Vier Pruefungen halten Fehlerklassen fest, die zwischen August und September 2026 mehrfach
aufgetreten sind. Sie gehoeren NICHT in `ci:smoke` und nicht in den Release-Gate `ci:strict`,
sondern auf den Server ins Deploy-Verzeichnis — vor dem Neustart bzw. vor dem naechsten Lauf
von `scripts/pins-erzeugen.js`.

Der Grund ist derselbe fuer alle vier und steht in ihren Kopfkommentaren: Ein CI-Runner hat
nach `npm ci` weder `stauden.db` noch `public/pins/` (beides steht in `.gitignore`). Alle vier
scheitern dort mit Absicht an ihrer Leerlaufsperre, statt „bestanden" zu melden. Eine Pruefung,
die nichts gesehen hat, darf nicht bestehen — sonst sagt ein gruenes CI nur aus, dass nichts
geprueft wurde. Deshalb ist `ci:smoke` unveraendert geblieben: Es muss ohne Produktionsdaten
durchlaufen koennen.

| Skript | npm | Braucht | Wann |
|---|---|---|---|
| `scripts/check-ki-kennzeichnung.js` | `check:ki` | Produktions-`stauden.db`, freien Port | vor jedem Deploy, der Bilder, Templates oder `scripts/bild-herkunft.js` beruehrt |
| `scripts/check-pin-deckung.js` | `check:pins` | gefuelltes `public/pins/` | vor jedem Lauf von `pins-erzeugen.js`, der neue Pins veroeffentlichungsreif macht |
| `scripts/check-pin-metadaten.js` | `check:pin-meta` | gefuelltes `public/pins/` | nach jedem Lauf von `pins-erzeugen.js` |
| `scripts/check-beispielplaene.js` | `check:beispiele` | Produktions-`stauden.db` | vor jedem Deploy, der `scripts/plan-pruefen.js`, die Schwellen darin oder einen Beispielplan beruehrt |

| `scripts/check-lebensbereich.js` | `check:lebensbereich` | Produktions-`stauden.db` | vor jedem Deploy, der Pflanzendaten aendert |

`check:lebensbereich` lief am 23.09.2026 kurzzeitig ausserhalb der Kette, weil sie einen
offenen Befund meldete (`Clematis x durandii`: `lebensbereich=Gehoelz` gegen `licht=Sonne`).
Entschieden hat das eine Recherche AUSSERHALB unserer Daten — aus den eigenen Feldern war
nicht zu sagen, welches der beiden falsch ist. Die Zeile steht jetzt auf
`Freiflaeche,Gehoelzrand`, der Lauf ist gruen, und die Pruefung ist zurueck in der Kette.
Wer kuenftig einen Befund bekommt, klaert ihn an einer externen Quelle — und nimmt die
Pruefung nicht heraus.

1. `check:ki` — Traegt jeder Ausgabepfad mit KI-Bild die Kennzeichnung, und traegt sie kein
   anderer? Startet den Server als Kindprozess (Port ueber `KI_PRUEF_PORT`, Vorgabe 3311) und
   fragt Seiten und JSON-Routen ab. Die Erwartung kommt aus `scripts/bild-herkunft.js`, nicht
   aus einer zweiten Fassung der Regel. `DB_PFAD` wird bewusst ignoriert: Der Server liest die
   Variable nicht, und eine Pruefung gegen eine andere Datenbank als der Server waere
   wertlos. Auf dem geteilten VPS ist vorher zu pruefen, dass der gewaehlte Port frei ist;
   der Kindprozess oeffnet dieselbe Datenbank wie die laufende App (schreibend geoeffnet,
   schreibt aber nichts ausser `CREATE TABLE IF NOT EXISTS` auf bereits vorhandene Tabellen).
2. `check:pins` — Nennt die Beschreibung eines noch nicht faelligen Pins eine Pflanze, die auf
   dem Bild nicht zu sehen ist? Stufe (i) liest ein JSON aus dem JPEG-Kommentar, Stufe (ii)
   vergleicht ersatzweise die Zeiten. Beides steht seit dem 22.09.2026: Die Bildbauer
   schreiben die IDs der abgebildeten Pflanzen beim Zeichnen in die Datei
   (`bildKommentarArgs()` in `scripts/pin-layout.js`), und jeder Listeneintrag traegt das Feld
   `text_am`.

   EINMALIG NOETIG, SONST BLEIBT DIE PRUEFUNG ROT: Den Bildkommentar bekommt nur ein NEU
   gebautes Bild. Die rund 490 schon liegenden, aber noch nicht faelligen Dateien brauchen
   deshalb einen Durchlauf mit dem neuen Schalter:

   ```
   node scripts/pins-erzeugen.js --neu-unveroeffentlicht
   ```

   Er baut genau die Bilder neu, deren Pin noch nicht veroeffentlicht ist, und laesst die der
   veroeffentlichten unangetastet — ihre Adresse steht bei Pinterest. `--neu` taete das nicht
   und ist mit dem Schalter zusammen deshalb ein Abbruch. Den Kommentar stattdessen
   nachtraeglich in die fertigen Dateien zu schreiben, faerbte die Pruefung gruen, ohne
   irgendetwas zu belegen: Man behauptete die heutige Auswahl ueber ein altes Bild.

   REIHENFOLGE BEIM ERSTEN MAL: Vor diesem Durchlauf meldet `check:pins` weiterhin Befunde —
   ein unveroeffentlichter Pin hat dann einen frischen `text_am`, aber ein Bild aus einem
   frueheren Lauf, und genau das meldet Stufe (ii). Die Aussage stimmt; erledigt ist sie erst
   nach dem Neubau. Danach greift bei jedem dieser Pins Stufe (i), und Stufe (ii) kommt gar
   nicht mehr zum Zug.
3. `check:pin-meta` — Traegt jede Pin-Datei mit KI-Inhalt das IPTC-Feld `DigitalSourceType`,
   und traegt es keine andere? Dazu die Kreuzprobe gegen die Beschreibung in `liste.json`.

Alle drei oeffnen die Datenbank mit `{ readonly: true }` und schreiben nichts.
Exitcode 1 heisst: Befund ODER nichts geprueft. Beides ist ein Grund, nicht zu deployen.

### Was davon doch in `ci:smoke` gehoert: die Selbsttests

`npm run check:selbsttest` (auch einzeln: `node scripts/check-*.js --selbsttest`) haelt den
Meldern erfundene Faelle hin — richtige und falsche — und prueft, ob sie genau die falschen
melden. Das braucht weder Datenbank noch Pins und laeuft deshalb im CI-Runner durch; es steht
seit 21.09.2026 in `ci:smoke`. Damit ist wenigstens der Melder selbst gegen stille
Verschlechterung geschuetzt: Wer die Ableitung in `scripts/bild-herkunft.js`, die Sortenliste
in `pin-layout.js` oder den Segmentleser in `pin-ki-metadaten.js` umbaut, faellt schon auf dem
Feature-Branch auf.

Der Selbsttest ersetzt den echten Lauf NICHT. Er belegt, dass die Pruefung urteilsfaehig ist,
nicht dass die Ausgabepfade in Ordnung sind. Ein gruenes `ci:smoke` sagt ueber die
Kennzeichnung in der Produktion nichts aus — dafuer ist `ci:daten` auf dem Server da.

## Winterbilder (einmaliger Ablauf auf dem Server, kostet Geld)

Die Pin-Sorte `pflanze-winter` spricht von Samenstaenden und Graeserstruktur und zeigte
dasselbe Bild wie der Bluehzeit-Pin — die Pflanze in BLUETE. Seit dem 22.09.2026 gibt es je
Pflanze ein zweites Bild: Spalte `bild_winter_url`, erzeugt von
`scripts/winterbilder-erzeugen.js`, benutzt von `scripts/pin-bild.js` im Wintermodus.

Vier Teile, und jeder hat seine eigene Stelle:

| Datei | Tut |
|---|---|
| `scripts/winterbild-auftrag.js` | Bildauftrag, Aspektliste, Dateiname, Bildwahl — EINE Fassung fuer Testlauf und Produktion |
| `scripts/winterbilder-erzeugen.js` | erzeugt die Bilder, schreibt NUR `bild_winter_url` |
| `scripts/check-plant-images.js --winter` | beurteilt sie mit eigenem Massstab, schreibt nie |
| `scripts/pins-erzeugen.js --neu-unveroeffentlicht` | bringt sie in die Pin-Dateien |

DER ABLAUF, IN DIESER REIHENFOLGE:

1. `pm2 restart staudenplan` nach dem Deploy — der Serverstart legt `bild_winter_url` an
   (Migrationsliste in `stauden-server.js`). Der Erzeuger legt die Spalte notfalls selbst an,
   aber die massgebliche Liste ist die im Server.
2. `node scripts/winterbilder-erzeugen.js --trocken --limit=3`
   Zeigt die Auftraege, erzeugt nichts, kostet nichts. Die Kopfzeile muss rund 163 Kandidaten
   nennen — steht dort 0, stimmt der Pin-Pool nicht (falsches Verzeichnis, fehlende Bilder).
3. `node scripts/winterbilder-erzeugen.js --limit=10` (~0,40 $)
   Erste zehn erzeugen und ansehen, bevor 163 bezahlt werden.
4. `node scripts/check-plant-images.js --winter` (~0,006 € je Bild)
   Beurteilt `bild_winter_url` mit dem Wintermassstab: plausibel DIESE Art im Ruhezustand,
   Bluetenfarbe zaehlt nicht. Der Modus schreibt nichts, auch `bild_geprueft` nicht.
5. `node scripts/winterbilder-erzeugen.js --nur-fehlende` (Rest, insgesamt ~6,52 $)
   Rund 35 Minuten bei 5 Bildern/Minute. Bricht der Lauf ab, ist derselbe Befehl die
   Wiederaufnahme: Was Spalte UND Datei hat, wird uebersprungen.
6. `node scripts/check-plant-images.js --winter` noch einmal fuer den Rest.
7. `node scripts/pins-erzeugen.js --nur pflanze-winter --neu-unveroeffentlicht`
   ERST HIER kommt das Winterbild in die Pin-Dateien. Ohne diesen Schritt liegen die Bilder
   bezahlt auf der Platte und kein Pin zeigt sie — die Pin-JPEGs sind fertige Dateien, keine
   Ansicht auf die Datenbank. Der Schalter laesst veroeffentlichte Pins unangetastet und
   braucht eine gefuellte `public/pins/liste.json` (sonst bricht er ab, mit Begruendung).
8. `npm run ci:daten` — muss gruen bleiben.

WAS DABEI SCHIEFGEHEN KANN:
- Schritt 5 ohne `--nur-fehlende` erzeugt die schon vorhandenen Bilder NOCH EINMAL und kostet
  erneut. Der Lauf sagt das vorher an.
- Bleibt Schritt 7 aus, aendert sich an den Pins nichts — und zwar still.
- `check:pins` prueft, ob die Beschreibung eines Pins Pflanzen nennt, die auf dem Bild nicht zu
  sehen sind. Das Winterbild aendert daran nichts: Es zeigt dieselbe eine Pflanze, der
  Bildkommentar traegt dieselbe eine Id.
- Die Termine der 163 Winterpins stehen schon (fruehester 01.11.2026). `pin-termine.js` ist
  nicht noetig; laeuft es doch, fuehrt es `check-pin-deckung` und `check-pin-metadaten` selbst
  aus und bricht bei Befunden ab.

## Notes
- Keep secrets out of repository files.
- Treat `ci:smoke` as required for API route changes and deploy-critical edits.
- `ci:daten` runs on the server only (see the German section above for the reasoning).
