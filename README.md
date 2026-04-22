# 🤖 PolitiPlot Auto-Poster

Merr lajme politike nga USA çdo orë, i rrishkruan 100% me Claude AI dhe i poston automatikisht në WordPress — pa shkruar asgjë ti.

---

## ⚡ Setup i Shpejtë

### Windows
1. Instalo **Node.js** → https://nodejs.org (shkarko LTS)
2. Klikoni 2x mbi **`setup.bat`** — bën gjithçka automatikisht
3. Plotëso skedarin `.env` që hapet (shiko poshtë)
4. Klikoni 2x mbi **`start.bat`** — sistemi niset!

### Mac / Linux
```bash
bash setup.sh    # instalon gjithçka
nano .env        # plotëso vlerat
npm start        # nis sistemin
```

---

## 🔑 Plotësimi i `.env`

Pasi të ekzekutosh `setup.bat` ose `setup.sh`, hapet skedari `.env`. Plotëso 4 vlerat:

### 1. ANTHROPIC_API_KEY
- Shko: **https://console.anthropic.com**
- Regjistrohu falas
- **API Keys → Create Key**
- Kopjo çelësin (fillon me `sk-ant-...`)

### 2. WP_URL
- URL-ja e faqes tënde: `https://politiplot.com`

### 3. WP_USER
- Username-i me të cilin hyn në WordPress

### 4. WP_APP_PASS — Application Password
1. Hyr në **WordPress Dashboard**
2. **Users → Profile**
3. Scroll poshtë te **"Application Passwords"**
4. Shkruaj emrin: `AutoPoster` → Kliko **Add New Application Password**
5. Kopjo passwordin që shfaqet (format: `xxxx xxxx xxxx xxxx xxxx xxxx`)

**Shembull `.env` i plotësuar:**
```
ANTHROPIC_API_KEY=sk-ant-api03-abc123...
WP_URL=https://politiplot.com
WP_USER=admin
WP_APP_PASS=AbCd EfGh IjKl MnOp QrSt UvWx
```

---

## 🌐 Hosting 24/7 (pa e lënë kompjuterin hapur)

### Railway.app — Falas, më i lehtë ✅
1. Ngarko skedarët në **GitHub** (github.com → New repo → upload files)
2. Shko: **https://railway.app** → regjistrohu me GitHub
3. **New Project → Deploy from GitHub Repo** → zgjidh repo-n
4. Shko te **Variables** dhe shto të 4 variablat nga `.env`
5. Railway e nis automatikisht dhe punon 24/7

### Render.com — Falas
1. **https://render.com** → New **Background Worker**
2. Lidh me GitHub repo
3. Build Command: `npm install`
4. Start Command: `node autoposter.js`
5. Shto Environment Variables

---

## 📊 Çfarë bën çdo orë

```
RSS (Reuters/Politico/NPR/NYT/WashPost/TheHill/CBS)
  ↓  merr lajmin e ri
Claude AI e rrishkruan 100% origjinal (550-700 fjalë)
  ↓  krijon: title, meta, slug, keyword, H2
WordPress REST API
  ↓  publikon automatikisht
posted.json  ←  ruan URL-të e postuara (nuk dyfishohet)
```

**SEO automatik:**
- Title 55-60 karaktere
- Meta description 150-160 karaktere  
- Focus keyword në paragraph të parë + H2
- Kategori + tags automatike
- Punon me **Yoast SEO** dhe **Rank Math**

---

## 🆘 Probleme

| Gabim | Zgjidhja |
|-------|----------|
| `Missing variables in .env` | Plotëso të 4 fushat në `.env` |
| `HTTP 401` | Kontrollo `WP_APP_PASS` — duhet Application Password, jo password normal |
| `HTTP 403` | Aktivizo REST API në WordPress → Settings → Permalinks → Save |
| `npm install` dështon | Kontrollo lidhjen me internet |
| `Cannot find module` | Ekzekuto `npm install` sërish |

---

*PolitiPlot Auto-Poster v2.0 · Powered by Claude AI (Anthropic)*
