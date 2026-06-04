# Bildprompts für nano banana2 — Staudenplan.de

Dateien speichern unter: `public/images/` (Ordner anlegen)
Format: JPG, Breite mind. 1920px (Hero) / 1200px (Ratgeber-Header) / 800px (allgemein)

---

## 1. HERO HAUPTSEITE
**Datei:** `public/images/hero-bg.jpg`
**Verwendung:** Hauptseite Hintergrund (mit grünem Overlay drüber)
**Prompt:**
```
Lush mixed perennial garden bed in full bloom, diverse colorful wildflowers and ornamental grasses, natural cottage style, soft golden morning light, shallow depth of field, bees and butterflies visible, German private garden, photorealistic, ultra detailed, 4k, wide angle, no people
```

---

## 2. RATGEBER KATEGORIE-HEADER

### 2a. Grundprinzipien
**Datei:** `public/images/ratgeber-grundprinzipien.jpg`
```
Top-down view of a beautifully designed perennial garden bed with clear planting layers, architectural plants in back, medium grasses in middle, low groundcover in front, professional garden design, bird's eye view, aerial photography, lush green, golden hour
```

### 2b. Standorte
**Datei:** `public/images/ratgeber-standorte.jpg`
```
Split view of different garden microhabitats: sunny dry border, shady woodland edge, moist streamside planting, all with thriving perennials, natural German garden, photorealistic, bright daylight, wide angle
```

### 2c. Gestaltung
**Datei:** `public/images/ratgeber-gestaltung.jpg`
```
Elegant cottage garden in full summer bloom, rich color palette of purples pinks whites and yellows, Piet Oudolf style naturalistic planting design, soft evening backlight, bokeh background, award-winning garden photography, 4k
```

### 2d. Ökologie
**Datei:** `public/images/ratgeber-oekologie.jpg`
```
Close-up of a bumblebee on purple Echinacea flower, surrounded by wildflowers in a natural garden, macro photography, golden bokeh background, soft natural light, conservation garden, photorealistic
```

### 2e. Praxis
**Datei:** `public/images/ratgeber-praxis.jpg`
```
Hands gently planting a perennial in rich dark garden soil, garden tools nearby, morning light, fresh soil texture, close-up photography, natural garden setting, authentic lifestyle feel, no face visible
```

### 2f. Kombinationen
**Datei:** `public/images/ratgeber-kombinationen.jpg`
```
Beautiful plant trio combination in a perennial border: tall ornamental grass Miscanthus, medium purple Salvia and low pink Sedum, perfect harmony of heights textures and colors, summer garden, professional garden photography
```

### 2g. Stil
**Datei:** `public/images/ratgeber-stil.jpg`
```
Classic German Bauerngarten with traditional cottage garden plants: roses, peonies, delphiniums, hollyhocks, wooden fence in background, romantic soft light, photorealistic, lush and colorful
```

---

## 3. ÜBER UNS / TRUST SECTION
**Datei:** `public/images/gartenschmiede-garten.jpg`
```
Professional German garden designer reviewing a planting plan on a tablet while standing in a beautiful summer garden with colorful perennial borders, warm professional atmosphere, lifestyle photography, natural light
```

---

## 4. HOW-IT-WORKS SECTION BACKGROUND
**Datei:** `public/images/planung-bg.jpg`
```
Flat lay of garden planning tools: graph paper with hand-drawn garden sketch, pencil, botanical books, dried flower samples, seed packets, measuring tape, natural linen background, overhead view, warm natural light
```

---

## 5. PFLANZENKARTEN FALLBACK (falls kein Wikipedia-Bild)
**Datei:** `public/images/pflanze-fallback.jpg`
```
Beautiful close-up of mixed perennial foliage and flower buds, green leaves with morning dew, soft bokeh, natural garden photography
```

---

## Einbindung nach Upload

Sobald Bilder unter `public/images/` gespeichert sind, sind sie automatisch verfügbar:
- Hero: Im HTML `<div style="background:url('/images/hero-bg.jpg')...">` ergänzen
- Ratgeber-Header: In der `KAT_CONFIG` im Server ist `img:` bereits vorbereitet
- Bilder erscheinen automatisch wenn Datei vorhanden
