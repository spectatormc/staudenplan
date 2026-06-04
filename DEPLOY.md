# Deployment Anleitung — Staudenplan.de

## Voraussetzungen
- Hetzner VPS (gleicher Server wie rollrasen-portal, IP: 88.198.151.84)
- Domain staudenplan.de zeigt auf diese IP (DNS A-Record)
- GitHub Repo: [URL eintragen]

---

## Schritt 1: DNS konfigurieren

Bei deinem Domain-Registrar (wo du staudenplan.de registriert hast):

```
A     @          88.198.151.84    (TTL 300)
A     www        88.198.151.84    (TTL 300)
```

Warten bis DNS propagiert (5-30 Min). Prüfen mit: https://dnschecker.org/#A/staudenplan.de

---

## Schritt 2: Server — Repo klonen

```bash
ssh root@88.198.151.84

cd /var/www
git clone https://github.com/[DEIN-USER]/staudenplan.git
cd staudenplan

npm install --production
```

---

## Schritt 3: .env erstellen

```bash
cp .env.example .env
nano .env
```

Eintragen:
```
PORT=3001
SITE_URL=https://www.staudenplan.de
OPENAI_API_KEY=sk-proj-[DEIN KEY]
ADMIN_PASSWORT=staudenplan2025
EMAIL_HOST=smtp.ionos.de
EMAIL_PORT=587
EMAIL_USER=info@staudenplan.de
EMAIL_PASS=[PASSWORT]
EMAIL_BETREIBER=rohrhuberbastian@gmail.com
```

---

## Schritt 4: Datenbank aufbauen

```bash
node scripts/setup-production.js
```

Erwartet: "✅ Setup abgeschlossen: 224 Pflanzen, 42 Wissenseintraege"

---

## Schritt 5: PM2 starten

```bash
pm2 start stauden-server.js --name staudenplan
pm2 save
pm2 status
```

Test: `curl http://localhost:3001` → sollte HTML zurückgeben

---

## Schritt 6: Nginx konfigurieren

```bash
nano /etc/nginx/sites-available/staudenplan.de
```

Inhalt:
```nginx
server {
    listen 80;
    server_name staudenplan.de www.staudenplan.de;
    return 301 https://www.staudenplan.de$request_uri;
}

server {
    listen 443 ssl;
    server_name staudenplan.de www.staudenplan.de;

    ssl_certificate /etc/letsencrypt/live/staudenplan.de/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/staudenplan.de/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;

    client_max_body_size 10M;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
ln -s /etc/nginx/sites-available/staudenplan.de /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

---

## Schritt 7: SSL-Zertifikat

```bash
certbot --nginx -d staudenplan.de -d www.staudenplan.de
```

---

## Schritt 8: Prüfen

- https://www.staudenplan.de  → Seite lädt
- https://www.staudenplan.de/sitemap.xml  → XML mit 269 URLs
- https://www.staudenplan.de/robots.txt  → Crawling erlaubt

---

## Schritt 9: Google Search Console

1. https://search.google.com/search-console/welcome
2. "URL-Präfix" → https://www.staudenplan.de
3. Verifizierung per DNS TXT-Record (einfachste Methode)
   - TXT-Record bei Registrar eintragen: google-site-verification=XXXX
4. Nach Verifizierung: Sitemap einreichen
   - Sitemaps → https://www.staudenplan.de/sitemap.xml

---

## Updates deployen

```bash
ssh root@88.198.151.84
cd /var/www/staudenplan
git pull
pm2 restart staudenplan
```
