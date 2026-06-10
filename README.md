<<<<<<< HEAD
# DevisPro CI

Bot conversationnel de génération de devis pour artisans en Côte d'Ivoire.
PDF professionnel · WhatsApp · Wave / Orange Money / MTN

---

## Structure du projet

```
devispro/
├── backend/
│   ├── server.js         # API Express principale
│   ├── schema.sql        # Base de données PostgreSQL
│   ├── package.json
│   └── .env.example      # Variables d'environnement
├── frontend/
│   ├── app.html          # PWA — interface chat principale
│   ├── manifest.json     # Manifest PWA
│   ├── sw.js             # Service Worker
│   └── js/
│       ├── api.js        # Client HTTP
│       ├── bot.js        # Logique conversation
│       └── app.js        # Contrôleur UI
└── demo/
    └── index.html        # Page démo interactive (Netlify)
```

---

## Déploiement backend (Render)

1. Créer un Web Service sur render.com
2. Connecter le repo GitHub
3. Root directory : `backend/`
4. Build command : `npm install`
5. Start command : `npm start`
6. Renseigner les variables d'environnement (voir `.env.example`)

### Variables d'environnement obligatoires

| Variable | Description |
|---|---|
| `DATABASE_URL` | URL PostgreSQL Render |
| `JWT_SECRET` | Clé secrète JWT (chaîne aléatoire longue) |
| `MISTRAL_API_KEY` | Clé API Mistral AI |
| `FRONTEND_URL` | URL du frontend Netlify |

### Initialiser la base de données

Après déploiement, exécuter le schéma SQL :
```bash
psql $DATABASE_URL < schema.sql
```

Ou via l'interface Render → Shell :
```bash
node -e "
const {Pool} = require('pg');
const fs = require('fs');
const pool = new Pool({connectionString: process.env.DATABASE_URL, ssl:{rejectUnauthorized:false}});
pool.query(fs.readFileSync('schema.sql','utf8')).then(()=>console.log('OK')).catch(console.error);
"
```

---

## Déploiement frontend PWA (Netlify)

1. Connecter le dossier `frontend/` à Netlify
2. Pas de build command (HTML/JS statique)
3. Publish directory : `frontend/`
4. Créer `frontend/js/config.js` avec :
```javascript
window.DEVISPRO_API_BASE = 'https://ton-backend.onrender.com';
```
5. Ajouter `<script src="/js/config.js">` avant `api.js` dans `app.html`

### `_redirects` Netlify (pour routing SPA)

Créer `frontend/_redirects` :
```
/*  /app.html  200
```

---

## Déploiement page démo (Netlify)

La page `demo/index.html` est autonome — aucune API requise.
Elle peut être déployée séparément sur Netlify, ou hébergée dans le même repo sur une branche `demo`.

---

## Architecture technique

- **Backend** : Node.js v24 + Express + PostgreSQL
- **IA** : Mistral AI (`mistral-large-latest`) via fetch natif
- **PDF** : pdfkit — génération côté serveur
- **Auth** : JWT (30 jours) + bcrypt
- **Rate limiting** : express-rate-limit v5.5.1
- **Frontend** : PWA HTML/CSS/JS — installable Android
- **Service Worker** : cache statiques offline, network-first pour API

## Règles Node.js v24

⚠️ Tous les `require()` sont en tête de fichier — ne pas déplacer.
`express-rate-limit` est épinglé à `5.5.1` — ne pas upgrader.

---

## Roadmap MVP → V2

| Phase | Durée | Statut |
|---|---|---|
| 1 — Backend + PDF + Auth | 1 sem | ✅ Livré |
| 2 — Frontend PWA + Bot | 1 sem | ✅ Livré |
| 3 — Intégration Wave CI | 1 sem | ⏳ À faire |
| 4 — WhatsApp Business API | 1 sem | ⏳ À faire |
| 5 — V2 (vocal, relances, factures) | 3 sem | ⏳ Backlog |
=======
# devispro-backend
>>>>>>> 510ffa72a8d1289df7c7d6b155d52f10fc52941a
