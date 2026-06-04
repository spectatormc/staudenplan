# SEO-Konzept — Mein Bepflanzungsplan

## Marktposition & USP

**Niemand** auf dem deutschen Markt kombiniert aktuell:
- KI-Fragebogen → personalisierter Bepflanzungsplan
- Direkte Pflanzenlieferung vom Partner

Planteplan.dk: kostenloser Planer, aber keine Lieferung.
Gaißmayer / Lubera: gute Shops, aber kein Planer.
Gardomat / GrünMaler: professionelle Planung, aber 200–300 €, nicht skalierbar.

**Unser USP:** In 2 Minuten zum fertigen Plan — und die Pflanzen kommen per Post.

---

## URL-Struktur

```
/                          → KI-Planer (Conversion-Seite)
/pflanzen                  → Stauden-Lexikon (224+ Arten)
/pflanze/[slug]            → Individuelle Pflanzenseite (SEO-Landingpage)
/ratgeber                  → Ratgeber-Übersicht (42+ Artikel)
/ratgeber/[slug]           → Einzelner Ratgeber-Artikel
```

Jede `/pflanze/` und `/ratgeber/` Seite ist eine eigene SEO-Landingpage mit Canonical-Tag.

---

## Keyword-Strategie

### Tier 1 — Hochvolumen, direkte Conversion
| Keyword | Intent | Ziel-URL |
|---|---|---|
| Bepflanzungsplan erstellen | Transaktional | / |
| Bepflanzungsplan kostenlos | Transaktional | / |
| Staudenbeet planen | Informational/Transaktional | / |
| Stauden kaufen | Transaktional | /pflanzen |
| Staudenbeet anlegen | Informational | /ratgeber/staudenbeet-anlegen-schritt-fuer-schritt-anleitung |

### Tier 2 — Long-Tail, hohe Relevanz
| Keyword | Ziel-URL |
|---|---|
| Stauden für Schatten | /ratgeber/stauden-fuer-den-schatten-die-besten-arten-fuer-dunkle-beete |
| pflegeleichte Stauden | /ratgeber/pflegeleichte-stauden-fuer-wenig-arbeit-im-garten |
| Stauden Vorgarten | /ratgeber/stauden-fuer-den-vorgarten-ideen-und-bepflanzungsplan |
| Stauden die lange blühen | /ratgeber/stauden-die-den-ganzen-sommer-bluehen |
| Stauden für Bienen | /ratgeber/stauden-fuer-bienen-und-insekten-insektenfreundlicher-garten |
| winterharte Stauden | /ratgeber/winterharte-stauden-fuer-deutschland-was-ueberleben-den-winter |
| Stauden kombinieren | /ratgeber/stauden-kombinieren-so-entstehen-schoene-beete |
| Bodendecker Stauden | /ratgeber/bodendecker-stauden-flaechendeckende-pflanzen-fuer-alle-standorte |

### Tier 3 — Pflanzennamen (224+ Seiten, cumulativ hoher Traffic)
Jede `/pflanze/` Seite rankt für:
- "[Deutscher Name] Standort Pflege"
- "[Botanischer Name] kaufen"
- "[Deutscher Name] Garten"

Beispiele: `geranium-sanguineum`, `hosta`, `salvia-nemorosa`, `echinacea-purpurea`

---

## On-Page SEO (bereits implementiert)

### Pflanzenseiten (`/pflanze/:slug`)
- ✅ `<title>`: Name (Botanisch) — Pflege, Standort & Verwendung
- ✅ `<meta description>`: Beschreibung + Pflege-Ankündigung
- ✅ `<link rel="canonical">`
- ✅ Schema.org `Product` JSON-LD
- ✅ Breadcrumb-Navigation
- ✅ Interne Verlinkung: "Ähnliche Stauden" + CTA zum Planer
- ✅ Kauflink zu Lubera (Affiliate)

### Ratgeber-Seiten (`/ratgeber/:slug`)
- ✅ `<title>`: Keyword-optimierter Artikeltitel
- ✅ `<meta description>`: Ersten 155 Zeichen des Artikels
- ✅ `<link rel="canonical">`
- ✅ CTA-Box → Planer (interne Verlinkung)
- ✅ "Verwandte Artikel" für interne Verlinkung

---

## Content-Strategie

### Phase 1 (jetzt): Fundament
- 224 Pflanzenseiten live
- 42 Ratgeber-Artikel live
- Alle wichtigen "Stauden für X"-Keywords abgedeckt

### Phase 2 (nächste 3 Monate): Ausbauen
Neue Ratgeber-Themen hinzufügen (via `node scripts/seed-wissen-seo.js` mit neuen Themen):
- "Staudenbeet Ideen mit Bildern" (hohe Suchvolumen)
- "Stauden Düngen — wann und womit?"
- "Stauden vermehren — Teilen, Aussaat, Stecklinge"
- "Stauden für Kübel und Balkon"
- "Stauden Nordhang" → bereits drin
- Lokale Seiten: "Stauden Bayern", "Staudengärtnerei kaufen in der Nähe"

### Phase 3: User-Generated Content
- Galerie: Nutzer teilen ihre generierten Pläne
- Bewertungen: Welche Pflanzen kamen gut an?

---

## Affiliate & Monetarisierung

| Partner | Provision | Programm | Priorität |
|---|---|---|---|
| **Lubera.com** | 12% | AWIN | ⭐ Sofort starten |
| **Staudengärtnerei Gaißmayer** | direkt verhandelbar | Direktvertrag | ⭐ Premium-Segment |
| **Bakker.com** | 10% (inaktiv, reaktivierbar) | — | Backup |
| **Amazon Plants** | 3-5% | Amazon Associates | Fallback |

**Aktionsplan Lubera:**
1. Registrierung bei AWIN (awin.com)
2. Lubera-Programm beitreten
3. Alle Kauflinks auf Tracking-Links umstellen
4. Conversion: ca. 1-3% der Besucher kaufen → bei 1.000 BesucherN/Monat × 50€ Warenkorb × 12% = **600 €/Monat passiv**

---

## Technisches SEO

### Sofort umsetzen
- [ ] `sitemap.xml` generieren (alle `/pflanze/` + `/ratgeber/` URLs)
- [ ] `robots.txt` erstellen
- [ ] Google Search Console anmelden + Sitemap einreichen
- [ ] Google Analytics / Plausible einrichten

### Sitemap-Route im Server hinzufügen
```javascript
app.get('/sitemap.xml', (req, res) => {
  const pflanzen = db.prepare('SELECT name_botanisch FROM pflanzen').all();
  const artikel = db.prepare('SELECT titel FROM wissen').all();
  // ... XML generieren
});
```

### Page Speed
- Keine externen JS/CSS-Abhängigkeiten → bereits schnell
- Bilder: Pflanzenseiten haben noch Emoji-Platzhalter → Echte Bilder später hinzufügen
- Core Web Vitals: SPA für Planer-Tool, statisch für SEO-Seiten → optimal

---

## Interne Verlinkungsstruktur

```
/ (Planer)
├── Links zu: /ratgeber, /pflanzen
│
/pflanzen
├── Links zu: jeder /pflanze/slug
│
/pflanze/[slug]
├── "Ähnliche Stauden" → andere /pflanze/ Seiten
├── CTA → / (Planer)
│
/ratgeber
├── Links zu: jedem /ratgeber/slug
│
/ratgeber/[slug]
├── "Verwandte Artikel" → andere /ratgeber/ Seiten
├── CTA → / (Planer)
```

**Ziel:** Jede Seite verlinkt zurück zum Planer (Conversion-Funnel).

---

## Wettbewerber-Gap-Analyse

| Feature | Planteplan | Gardomat | Lubera | **Unser Tool** |
|---|---|---|---|---|
| KI-Fragebogen | ❌ | ❌ | ❌ | ✅ |
| Personalisierter Plan | ⚡ manuell | ✅ teuer | ❌ | ✅ kostenlos |
| Direkte Lieferung | ❌ | ❌ | ✅ | ✅ |
| SEO-Content (Pflanzen) | ❌ | ❌ | ✅ begrenzt | ✅ 224+ Seiten |
| Ratgeber-Content | ❌ | ❌ | begrenzt | ✅ 42+ Artikel |
| Kostenlos | ✅ | ❌ (ab 200€) | ✅ | ✅ |

---

## KPIs & Ziele (6 Monate)

| Metrik | Ziel |
|---|---|
| Organischer Traffic | 2.000 Besucher/Monat |
| Pflanzenseiten indexiert | 200+ |
| Ratgeber indexiert | 40+ |
| Conversion Rate (Plan erstellt) | 5% |
| Affiliate-Einnahmen | 300–600 €/Monat |
| E-Mail-Adressen (via Anfragen) | 100+ |

---

## Nächste Schritte (Priorität)

1. **SOFORT:** Lubera AWIN-Affiliate anmelden → alle Kauflinks tracken
2. **Woche 1:** Sitemap.xml + robots.txt + Google Search Console
3. **Woche 2:** Gaißmayer kontaktieren für Direktpartnerschaft
4. **Monat 1:** 20 weitere Ratgeber (via seed-wissen-seo.js)
5. **Monat 2:** Echte Produktbilder für Top-50-Pflanzen
6. **Monat 3:** Social Media (Pinterest) mit Pflanzenkarten
