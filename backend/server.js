// ══════════════════════════════════════════════════════════════
// DevisPro CI — server.js v4.5
// Node.js v24 : tous les require() en tête de fichier (règle critique)
// v4.5 : lien partage court /d/XXXXXXXX (8 cars) stocké en base
// ══════════════════════════════════════════════════════════════
require('dotenv').config();

const express        = require('express');
const cors           = require('cors');
const helmet         = require('helmet');
const rateLimit      = require('express-rate-limit');
const { Pool }       = require('pg');
const jwt            = require('jsonwebtoken');
const bcrypt         = require('bcryptjs');
const PDFDocument    = require('pdfkit');
const { v4: uuidv4 } = require('uuid');
const fs             = require('fs');
const path           = require('path');
const multer         = require('multer');

// ── Vérification des secrets critiques au démarrage ─────────────
// [FIX #2 - 27/07/2026] Plus AUCUN fallback en dur pour ADMIN_PASSWORD :
// avant, `ADMIN_PASSWORD || 'devispro_admin_2026'` donnait un accès admin
// avec un mot de passe public (visible dans le repo GitHub) si la variable
// d'env était absente. Maintenant le serveur refuse de démarrer.
const REQUIRED_ENV = ['JWT_SECRET', 'ADMIN_PASSWORD', 'DATABASE_URL', 'MISTRAL_API_KEY'];
const missingEnv   = REQUIRED_ENV.filter(k => !process.env[k]);
if (missingEnv.length > 0) {
  console.error(`[BOOT] Variables d'environnement manquantes : ${missingEnv.join(', ')}`);
  console.error('[BOOT] Arrêt du serveur — aucun fallback en dur pour les secrets.');
  process.exit(1);
}

// ── App ────────────────────────────────────────────────────────
const app         = express();
const PORT        = process.env.PORT || 3000;
const BACKEND_URL = process.env.BACKEND_URL || 'https://blud911-devispro-backend.onrender.com';

// ── Formatage FCFA ─────────────────────────────────────────────
function fcfa(n) {
  return String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

// ── Code partage court ─────────────────────────────────────────
// ✅ v4.5 : 8 caractères alphanumériques lisibles
function makeShareCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ── Middleware ─────────────────────────────────────────────────
// [FIX #6 - 27/07/2026] Helmet : en-têtes de sécurité HTTP (CSP, X-Frame-Options, etc.)
// CSP désactivée car le frontend est servi séparément (Netlify) ; ce backend ne sert
// que du JSON + PDF + la page /d/:code, donc pas de risque XSS lié à du HTML inline ici.
app.use(helmet({ contentSecurityPolicy: false }));

// [FIX #5 - 27/07/2026] CORS fail-closed : avant, l'absence de FRONTEND_URL ouvrait
// l'API à n'importe quelle origine ('*'). Maintenant, liste blanche explicite ;
// FRONTEND_URL peut contenir plusieurs origines séparées par des virgules.
const allowedOrigins = (process.env.FRONTEND_URL || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);
app.use(cors({
  origin: (origin, callback) => {
    // Requêtes sans origine (Postman, curl, apps mobiles) : autorisées côté serveur,
    // la vraie protection est le token JWT sur chaque route.
    if (!origin) return callback(null, true);
    if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Origine non autorisée par CORS'));
  }
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Rate limiting ──────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Trop de requêtes, réessaie dans 15 minutes.' }
});
app.use('/api/', limiter);

// [FIX #3 - 27/07/2026] Rate-limit dédié et strict pour les routes sensibles
// (login artisan, login admin, activation par code) — indépendant du rate-limit
// global de 100 req/15min qui laissait trop de marge pour du bruteforce.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  message: { error: 'Trop de tentatives. Réessaie dans 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false
});

// Rate-limit léger et dédié pour l'envoi de devis par email (Brevo) : pas besoin
// d'être aussi strict que authLimiter, mais évite qu'un artisan qui spamme le
// bouton "Envoyer par mail" ne consomme le quota Brevo ou ne harcèle le client.
const emailLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  message: { error: "Trop d'envois d'email. Réessaie dans 10 minutes." },
  standardHeaders: true,
  legacyHeaders: false
});

// ── Variables d'environnement optionnelles (envoi email via Brevo) ──────
// La fonctionnalité "envoyer le devis par email" reste DÉSACTIVÉE tant que
// BREVO_API_KEY n'est pas définie — le serveur démarre normalement sans.
//   BREVO_API_KEY       clé API transactionnelle Brevo (obligatoire pour activer l'envoi)
//   BREVO_SENDER_EMAIL  adresse expéditeur vérifiée dans Brevo (obligatoire pour activer l'envoi)
//   BREVO_SENDER_NAME   nom affiché de l'expéditeur (optionnel, défaut : "DevisPro CI")

// ── PostgreSQL ─────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// ── Multer ─────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, `${uuidv4()}${path.extname(file.originalname)}`);
  }
});
// [FIX #4 - 27/07/2026] fileFilter ajouté : avant, n'importe quel type de fichier
// pouvait être uploadé comme logo (script, HTML, exécutable déguisé). Maintenant,
// seuls les types image courants sont acceptés.
const ALLOWED_LOGO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_LOGO_TYPES.includes(file.mimetype)) {
      return cb(new Error('Type de fichier non autorisé (jpeg, png, webp uniquement)'));
    }
    cb(null, true);
  }
});

// [FIX #4 - 27/07/2026] Route de service manquante : logo_url pointait vers
// /uploads/... mais rien ne servait ce dossier — les logos ne s'affichaient jamais.
// ⚠️ Le disque Render est éphémère (perdu à chaque redeploy/restart) : correct pour
// débloquer la fonctionnalité tout de suite, mais un stockage externe (Cloudflare R2,
// S3...) serait plus fiable à moyen terme si les logos doivent survivre aux déploiements.
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ── Auth middleware ────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'Token manquant' });
  const token = header.split(' ')[1];
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token invalide' });
  }
}

// ── Éligibilité "analyse photo" par métier ─────────────────────
// L'analyse photo (Pixtral) ne sait estimer qu'une PIÈCE (surface
// longueur × largeur) ou lire un DOCUMENT/FACTURE. Elle n'a de sens que
// pour les métiers du bâtiment / travaux de surface. Pour les autres
// métiers (mécanique auto, réparation électroménager...), le bouton photo
// est masqué côté frontend ET la route /api/bot/photo refuse la requête
// (défense en profondeur). Le champ `metier` reste en texte libre : on ne
// change pas la saisie, on détecte juste par mots-clés.
// Mots-clés stockés déjà normalisés (minuscule, sans accent).
const METIERS_PHOTO_ELIGIBLES = [
  'carrel', 'peintr', 'plafond', 'macon', 'plaqu', 'couvr', 'toiture',
  'menuis', 'plomb', 'electric', 'etancheite', 'climatisation', 'faience',
  'batiment', 'construction', 'renovation', 'gros oeuvre'
];

// normaliser : met en minuscule et retire les accents / diacritiques
// (normalize('NFD') sépare les caractères accentués, la regex \p{Diacritic}
// supprime les signes diacritiques ; les ligatures œ/æ sont dépliées à la
// main car NFD ne les décompose pas).
function normaliser(txt) {
  return String(txt || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae');
}

// isMetierEligiblePhoto : true si le métier (texte libre) contient un des
// mots-clés bâtiment/surface une fois normalisé.
function isMetierEligiblePhoto(metier) {
  const m = normaliser(metier);
  return METIERS_PHOTO_ELIGIBLES.some(kw => m.includes(kw));
}

// ── Admin auth middleware ──────────────────────────────────────
function adminAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'Token admin manquant' });
  const token = header.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded.admin) return res.status(403).json({ error: 'Accès refusé' });
    next();
  } catch {
    res.status(401).json({ error: 'Token admin invalide' });
  }
}

// ── Helpers ────────────────────────────────────────────────────
function makeActivationCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'DEV';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function parseJson(val) {
  if (!val) return [];
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch { return []; }
  }
  return val;
}

// Troncature défensive : coupe une valeur texte à la longueur max de sa colonne
// avant insertion, pour éviter un échec Postgres 22001 (value too long) quand le
// bot IA renvoie un texte anormalement long.
const tronque = (val, max) => (val || '').toString().slice(0, max);

// Normalise un email client : renvoie l'adresse nettoyée si elle est plausible,
// sinon null. Le bot peut envoyer "non" / "null" / "" quand l'artisan n'a pas
// l'email — on ne stocke jamais ces valeurs comme une vraie adresse.
function normalizeEmail(val) {
  if (!val || typeof val !== 'string') return null;
  const e = val.trim().toLowerCase();
  if (!e || e.length > 150) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
  return e;
}

// ══════════════════════════════════════════════════════════════
// CRON QUOTIDIEN
// ══════════════════════════════════════════════════════════════
async function expireArtisans() {
  try {
    const result = await pool.query(
      `UPDATE artisans
       SET statut = 'suspendu'
       WHERE statut = 'actif'
         AND plan != 'gratuit'
         AND expires_at IS NOT NULL
         AND expires_at < NOW()
       RETURNING id, nom, telephone`
    );
    if (result.rowCount > 0) {
      console.log(`[CRON] ${result.rowCount} artisan(s) expirés :`,
        result.rows.map(r => `${r.nom} (${r.telephone})`).join(', '));
    } else {
      console.log('[CRON] Aucun artisan expiré.');
    }
  } catch (err) {
    console.error('[CRON] Erreur expiration artisans :', err.message);
  }
}

expireArtisans();
setInterval(expireArtisans, 24 * 60 * 60 * 1000);

// ══════════════════════════════════════════════════════════════
// GÉNÉRATEUR PDF
// ══════════════════════════════════════════════════════════════
// buildDevisPDF : produit le PDF sous forme de Buffer réutilisable (collecte des
// chunks via doc.on('data')/doc.on('end')). Toute la mise en page vit ici — un
// seul endroit — et sert aussi bien le streaming HTTP que la pièce jointe email.
function buildDevisPDF({ artisan, numero, numero_facture, reference_bien, client_nom, client_telephone, objet, type_travaux, lignes, surfaces, main_oeuvre, acompte, totalHT }) {
  return new Promise((resolve, reject) => {
    const doc    = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];
    doc.on('data',  chunk => chunks.push(chunk));
    doc.on('end',   () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const BLUE = '#1A3A5C', GOLD = '#C9952B', GRAY = '#F5F5F5',
          WHITE = '#FFFFFF', DARK = '#1C1C1C', pageW = 495;

    // Un devis devient une FACTURE une fois "marqué payé" (numero_facture rempli).
    // On distingue alors visuellement le document (libellé + numéro affiché) sans
    // changer la mise en page.
    const estFacture    = !!numero_facture;
    const typeDoc       = estFacture ? 'FACTURE' : 'DEVIS';
    const numeroAffiche = estFacture ? numero_facture : numero;

    // ── En-tête ───────────────────────────────────────────────
    doc.rect(0, 0, 595, 90).fill(BLUE);
    doc.fillColor(WHITE).fontSize(22).font('Helvetica-Bold').text(artisan.nom_entreprise || 'DevisPro CI', 50, 20);
    doc.fontSize(10).font('Helvetica')
       .text(`${artisan.nom} ${artisan.prenom || ''} — ${artisan.metier}`, 50, 48)
       .text(`Tél : ${artisan.telephone}`, 50, 62);
    // fontSize 9 (et non 10) pour cette ligne uniquement : "FACTURE FACT-xxxxxxxxxxxxx"
    // fait ~137,5 pt en Helvetica-Bold 9 (calcul de largeur de glyphes AFM) et tient
    // donc sur une seule ligne dans les 145 px ; à fontSize 10 il faisait ~152,8 pt et
    // débordait sur deux lignes, chevauchant "Date : ...". Date/Validité décalés de
    // 2 px vers le bas pour garder de la marge même si le texte du dessus repassait
    // un jour sur deux lignes.
    doc.fillColor(GOLD).fontSize(9).font('Helvetica-Bold')
       .text(`${typeDoc} ${numeroAffiche}`, 400, 30, { align: 'right', width: 145 });
    doc.fillColor(WHITE).font('Helvetica').fontSize(9)
       .text(`Date : ${new Date().toLocaleDateString('fr-FR')}`, 400, 50, { align: 'right', width: 145 })
       .text('Validité : 30 jours', 400, 64, { align: 'right', width: 145 });

    // ── Bloc client ───────────────────────────────────────────
    doc.rect(50, 105, pageW, 60).fill(GRAY);
    doc.fillColor(BLUE).fontSize(9).font('Helvetica-Bold').text('CLIENT', 60, 112);
    doc.fillColor(DARK).font('Helvetica').fontSize(11).text(client_nom, 60, 126);
    if (client_telephone) doc.fontSize(9).fillColor('#555555').text(`Tél : ${client_telephone}`, 60, 142);
    if (reference_bien) doc.fontSize(9).fillColor('#555555').text(`Réf. : ${reference_bien}`, 60, 154);
    if (objet) {
      doc.fillColor(GOLD).fontSize(9).font('Helvetica-Bold').text('OBJET', 320, 112);
      doc.fillColor(DARK).font('Helvetica').fontSize(10).text(objet, 320, 126, { width: 200 });
    }

    // ── Surfaces ──────────────────────────────────────────────
    let y = 185;
    if (surfaces && surfaces.length > 0) {
      doc.fillColor(BLUE).fontSize(9).font('Helvetica-Bold').text('SURFACES', 50, y); y += 14;
      surfaces.forEach(s => {
        doc.fillColor(DARK).font('Helvetica').fontSize(9)
           .text(`${s.nom_piece} : ${s.longueur}m × ${s.largeur}m = ${s.surface} m²`, 60, y);
        y += 14;
      });
      y += 6;
    }

    // ── Tableau lignes ────────────────────────────────────────
    const colX = [50, 230, 295, 360, 445], colW = [180, 65, 65, 85, 100];
    doc.rect(50, y, pageW, 22).fill(BLUE);
    ['Désignation', 'Qté', 'Unité', 'P.U (FCFA)', 'Total (FCFA)'].forEach((h, i) => {
      doc.fillColor(WHITE).fontSize(9).font('Helvetica-Bold')
         .text(h, colX[i], y + 7, { width: colW[i], align: i > 0 ? 'center' : 'left' });
    });
    y += 22;

    lignes.forEach((l, idx) => {
      const total = l.quantite * l.prix_unitaire;
      doc.rect(50, y, pageW, 20).fill(idx % 2 === 0 ? WHITE : GRAY);
      [l.designation, String(l.quantite), l.unite || 'u.',
       fcfa(l.prix_unitaire), fcfa(total)
      ].forEach((c, i) => {
        doc.fillColor(DARK).font('Helvetica').fontSize(9)
           .text(c, colX[i], y + 6, { width: colW[i], align: i > 0 ? 'center' : 'left' });
      });
      y += 20;
    });

    // ── Main-d'œuvre ──────────────────────────────────────────
    if (main_oeuvre > 0) {
      doc.rect(50, y, pageW, 20).fill('#EEF4FA');
      doc.fillColor(BLUE).font('Helvetica-Bold').fontSize(9)
         .text("Main-d'œuvre", colX[0], y + 6, { width: colW[0] });
      doc.fillColor(DARK).font('Helvetica').fontSize(9)
         .text(fcfa(main_oeuvre), colX[4], y + 6, { width: colW[4], align: 'center' });
      y += 20;
    }

    // ── Totaux ────────────────────────────────────────────────
    y += 10;
    doc.moveTo(50, y).lineTo(545, y).strokeColor(GOLD).lineWidth(1).stroke();
    y += 10;

    const totaux = [
      ['Sous-total fournitures', lignes.reduce((s, l) => s + l.quantite * l.prix_unitaire, 0)],
      ["Main-d'œuvre", main_oeuvre || 0],
      ['TOTAL TTC', totalHT]
    ];
    if (acompte > 0) totaux.push(['Acompte demandé', acompte]);

    totaux.forEach(([label, val]) => {
      const isTotal = label === 'TOTAL TTC';
      if (isTotal) doc.rect(325, y - 2, 220, 22).fill(BLUE);
      doc.fillColor(isTotal ? WHITE : DARK)
         .font(isTotal ? 'Helvetica-Bold' : 'Helvetica')
         .fontSize(isTotal ? 11 : 9)
         .text(label, 330, y + (isTotal ? 5 : 2), { width: 135 })
         .text(`${fcfa(val)} FCFA`, 465, y + (isTotal ? 5 : 2), { width: 80, align: 'right' });
      y += isTotal ? 24 : 18;
    });

    // ── Pied de page ──────────────────────────────────────────
    y += 20;
    doc.rect(50, y, pageW, 40).fill(GRAY);
    doc.fillColor('#555555').fontSize(8).font('Helvetica')
       .text('Paiement accepté : Wave CI · Orange Money · MTN Mobile Money', 60, y + 8)
       .text("Ce devis est valable 30 jours à compter de sa date d'émission.", 60, y + 22);
    doc.fillColor(GOLD).fontSize(7).font('Helvetica')
       .text('Généré par DevisPro CI', 50, 820, { align: 'center', width: pageW });

    doc.end();
  });
}

// generatePDF : conserve l'ancienne signature ({ ..., res }) pour que les routes
// existantes continuent de streamer le PDF directement vers la réponse HTTP, en
// s'appuyant sur la fonction commune buildDevisPDF (aucune logique de mise en
// page dupliquée). Renvoie aussi le Buffer généré au cas où l'appelant en veut.
async function generatePDF({ res, ...data }) {
  const buffer = await buildDevisPDF(data);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="devis-${data.numero}.pdf"`);
  res.send(buffer);
  return buffer;
}

// ══════════════════════════════════════════════════════════════
// ROUTES AUTH
// ══════════════════════════════════════════════════════════════

app.post('/api/auth/register', authLimiter, async (req, res) => {
  const { nom, prenom, telephone, metier, password, email, nom_entreprise } = req.body;
  if (!nom || !telephone || !metier || !password) {
    return res.status(400).json({ error: 'Champs obligatoires manquants' });
  }
  // [FIX #10 - 27/07/2026] Longueur minimale imposée côté backend (rien n'était vérifié avant)
  if (password.length < 8) {
    return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères' });
  }
  // Email de contact de l'artisan : facultatif, jamais bloquant. On réutilise
  // normalizeEmail() (même fonction que pour client_email sur un devis) : une
  // valeur absente / vide / invalide devient null, sans erreur.
  const artisanEmail = normalizeEmail(email);
  // Nom de l'entreprise/activité : texte libre, facultatif, jamais bloquant et
  // jamais dans les champs obligatoires. Aucune validation de format ; on stocke
  // null si rien n'est fourni.
  const nomEntreprise = (nom_entreprise || '').toString().trim() || null;
  try {
    const hash   = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO artisans (id, nom, prenom, telephone, metier, nom_entreprise, email, password_hash, devis_count, statut, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,'en_attente',NOW()) RETURNING id`,
      [uuidv4(), nom, prenom || '', telephone, metier, nomEntreprise, artisanEmail, hash]
    );
    const tempToken = jwt.sign({ id: result.rows[0].id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({
      message: "Inscription reçue. Entrez votre code d'activation.",
      statut:  'en_attente',
      token:   tempToken
    });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ce numéro est déjà inscrit' });
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { telephone, password } = req.body;
  try {
    const result  = await pool.query('SELECT * FROM artisans WHERE telephone = $1', [telephone]);
    const artisan = result.rows[0];
    if (!artisan) return res.status(401).json({ error: 'Numéro ou mot de passe incorrect' });

    const valid = await bcrypt.compare(password, artisan.password_hash);
    if (!valid) return res.status(401).json({ error: 'Numéro ou mot de passe incorrect' });

    if (artisan.statut === 'actif' && artisan.plan !== 'gratuit' && artisan.expires_at && new Date(artisan.expires_at) < new Date()) {
      await pool.query(`UPDATE artisans SET statut='suspendu' WHERE id=$1`, [artisan.id]);
      return res.status(403).json({
        error:  "Votre abonnement a expiré. Contactez l'administrateur pour renouveler.",
        statut: 'expiré'
      });
    }

    if (artisan.statut === 'en_attente') {
      const tempToken = jwt.sign({ id: artisan.id }, process.env.JWT_SECRET, { expiresIn: '7d' });
      return res.status(403).json({
        error:  "Compte en attente d'activation. Entrez votre code d'activation.",
        statut: 'en_attente',
        token:  tempToken
      });
    }

    if (artisan.statut === 'suspendu') {
      return res.status(403).json({
        error:  "Votre abonnement a expiré. Contactez l'administrateur pour renouveler.",
        statut: 'suspendu'
      });
    }

    const token = jwt.sign({ id: artisan.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({
      token,
      artisan: {
        id:               artisan.id,
        nom:              artisan.nom,
        telephone:        artisan.telephone,
        metier:           artisan.metier,
        plan:             artisan.plan,
        devis_count:      artisan.devis_count,
        statut:           artisan.statut,
        expires_at:       artisan.expires_at,
        email:            artisan.email,
        nom_entreprise:   artisan.nom_entreprise,
        photo_disponible: isMetierEligiblePhoto(artisan.metier)
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/auth/activate', authLimiter, authMiddleware, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code manquant' });
  try {
    const codeResult = await pool.query(
      'SELECT * FROM activation_codes WHERE code=$1 AND used=false',
      [code.toUpperCase().trim()]
    );
    if (!codeResult.rows.length) return res.status(400).json({ error: 'Code invalide ou déjà utilisé' });

    const activationCode = codeResult.rows[0];
    if (activationCode.artisan_id && activationCode.artisan_id !== req.user.id) {
      return res.status(400).json({ error: 'Ce code ne vous est pas destiné' });
    }

    await pool.query(
      `UPDATE artisans SET statut='actif', expires_at=NOW() + INTERVAL '30 days' WHERE id=$1`,
      [req.user.id]
    );
    await pool.query(
      'UPDATE activation_codes SET used=true, used_at=NOW(), artisan_id=$1 WHERE id=$2',
      [req.user.id, activationCode.id]
    );

    const artisanResult = await pool.query(
      'SELECT id, nom, telephone, metier, plan, devis_count, statut, expires_at FROM artisans WHERE id=$1',
      [req.user.id]
    );
    const artisan = artisanResult.rows[0];
    artisan.photo_disponible = isMetierEligiblePhoto(artisan.metier);
    const token   = jwt.sign({ id: artisan.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ success: true, token, artisan });
  } catch (err) {
    console.error('[ACTIVATE]', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ══════════════════════════════════════════════════════════════
// ROUTES PROFIL
// ══════════════════════════════════════════════════════════════

app.get('/api/profil', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, nom, prenom, telephone, metier, nom_entreprise, email, logo_url, devis_count, plan, statut, expires_at FROM artisans WHERE id=$1',
      [req.user.id]
    );
    const artisan = result.rows[0];
    if (artisan) artisan.photo_disponible = isMetierEligiblePhoto(artisan.metier);
    res.json(artisan);
  } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.put('/api/profil', authMiddleware, async (req, res) => {
  // Mise à jour partielle : on ne touche QUE les colonnes réellement présentes
  // dans req.body. Un appel { nom, metier } ne modifie jamais telephone/prenom.
  // `email` (contact artisan, facultatif) passe par normalizeEmail() : une
  // valeur invalide devient null, jamais une erreur.
  const CHAMPS_AUTORISES = ['nom', 'prenom', 'telephone', 'metier', 'nom_entreprise', 'email'];
  const colonnes = [];
  const valeurs  = [];

  for (const champ of CHAMPS_AUTORISES) {
    if (Object.prototype.hasOwnProperty.call(req.body, champ)) {
      const valeur = champ === 'email' ? normalizeEmail(req.body.email) : req.body[champ];
      valeurs.push(valeur);
      colonnes.push(`${champ}=$${valeurs.length}`);
    }
  }

  if (colonnes.length === 0) return res.json({ success: true });

  valeurs.push(req.user.id);

  try {
    await pool.query(
      `UPDATE artisans SET ${colonnes.join(', ')} WHERE id=$${valeurs.length}`,
      valeurs
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.post('/api/profil/logo', authMiddleware, upload.single('logo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });
  const logoUrl = `/uploads/${req.file.filename}`;
  try {
    await pool.query('UPDATE artisans SET logo_url=$1 WHERE id=$2', [logoUrl, req.user.id]);
    res.json({ logo_url: logoUrl });
  } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

// ══════════════════════════════════════════════════════════════
// ROUTES TARIFS
// ══════════════════════════════════════════════════════════════

app.get('/api/tarifs', authMiddleware, async (req, res) => {
  const q = `%${(req.query.q || '').toLowerCase()}%`;
  try {
    const result = await pool.query(
      `SELECT designation, unite, prix_unitaire, usage_count
       FROM tarifs WHERE artisan_id=$1 AND LOWER(designation) LIKE $2
       ORDER BY usage_count DESC LIMIT 10`,
      [req.user.id, q]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

// ══════════════════════════════════════════════════════════════
// ROUTES DEVIS
// ══════════════════════════════════════════════════════════════

app.post('/api/devis', authMiddleware, async (req, res) => {
  const { client_nom, client_telephone, client_email, objet, type_travaux, lignes, main_oeuvre, acompte, surfaces, reference_bien } = req.body;
  if (!client_nom || !lignes || !lignes.length) {
    return res.status(400).json({ error: 'Données incomplètes' });
  }
  // Email client facultatif : jamais bloquant, stocké seulement s'il est plausible.
  const clientEmail = normalizeEmail(client_email);
  try {
    const artisanResult = await pool.query('SELECT * FROM artisans WHERE id=$1', [req.user.id]);
    const artisan = artisanResult.rows[0];

    if (artisan.statut === 'suspendu') {
      return res.status(403).json({ error: "Votre abonnement a expiré. Contactez l'administrateur." });
    }
    if (artisan.plan === 'gratuit' && artisan.devis_count >= 3) {
      return res.status(403).json({ error: 'Quota gratuit atteint.', quota_depasse: true });
    }

    const totalFournitures = lignes.reduce((sum, l) => sum + (l.quantite * l.prix_unitaire), 0);
    const totalHT  = totalFournitures + (main_oeuvre || 0);
    const numero   = `DEV-${Date.now()}`;
    const devisId  = uuidv4();
    const pdfUrl   = `${BACKEND_URL}/api/devis/${devisId}/pdf`;

    // Troncature défensive aux limites de colonnes définies dans schema.sql,
    // pour éviter un échec Postgres 22001 (value too long) :
    //   devis.client_nom        VARCHAR(150)
    //   devis.client_telephone  VARCHAR(20)
    //   devis.type_travaux      VARCHAR(100)
    //   devis.reference_bien    VARCHAR(150)
    //   devis.objet             TEXT  → aucune limite en base, pas de troncature
    //   tarifs.designation      VARCHAR(200)
    //   tarifs.unite            VARCHAR(50)
    const clientNom     = tronque(client_nom, 150);
    const clientTel     = tronque(client_telephone, 20);
    const typeTravaux   = tronque(type_travaux, 100);
    // Référence libre du bien (immatriculation véhicule, modèle appareil…) :
    // facultatif, jamais bloquant, tronqué à la limite de colonne comme les autres.
    const referenceBien = tronque(reference_bien, 150);

    await pool.query(
      `INSERT INTO devis (id, artisan_id, numero, client_nom, client_telephone, client_email, objet,
        type_travaux, lignes, surfaces, main_oeuvre, acompte, total, statut, pdf_url, reference_bien, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'envoye',$14,$15,NOW())`,
      [devisId, req.user.id, numero, clientNom, clientTel, clientEmail, objet || '',
       typeTravaux, JSON.stringify(lignes), JSON.stringify(surfaces || []),
       main_oeuvre || 0, acompte || 0, totalHT, pdfUrl, referenceBien]
    );

    for (const l of lignes) {
      await pool.query(
        `INSERT INTO tarifs (id, artisan_id, designation, unite, prix_unitaire, usage_count)
         VALUES ($1,$2,$3,$4,$5,1)
         ON CONFLICT (artisan_id, designation)
         DO UPDATE SET prix_unitaire=$5, usage_count=tarifs.usage_count+1`,
        [uuidv4(), req.user.id, tronque(l.designation, 200), tronque(l.unite || 'unité', 50), l.prix_unitaire]
      );
    }

    await pool.query('UPDATE artisans SET devis_count=devis_count+1 WHERE id=$1', [req.user.id]);

    res.status(201).json({ id: devisId, numero, total: totalHT, client_email: clientEmail, pdf_url: pdfUrl, message: `Devis ${numero} créé` });
  } catch (err) {
    // [22001] PostgreSQL : "value too long for type character varying(n)".
    // Filet en cas de valeur trop longue malgré la troncature défensive :
    // message clair en 400 plutôt qu'un 500 générique.
    if (err.code === '22001') {
      return res.status(400).json({ error: 'Une des valeurs du devis est trop longue, réessaie avec un texte plus court.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la création du devis' });
  }
});

// GET /api/devis/:id/pdf — PDF privé avec token JWT
app.get('/api/devis/:id/pdf', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1] || req.query.token;
  if (!token) return res.status(401).json({ error: 'Token manquant' });

  let userId;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    userId = decoded.id;
  } catch {
    return res.status(401).json({ error: 'Token invalide' });
  }

  try {
    const devisResult = await pool.query(
      'SELECT * FROM devis WHERE id=$1 AND artisan_id=$2',
      [req.params.id, userId]
    );
    if (!devisResult.rows.length) return res.status(404).json({ error: 'Devis introuvable' });

    const devis         = devisResult.rows[0];
    const artisanResult = await pool.query(
      'SELECT id, nom, prenom, telephone, metier, nom_entreprise FROM artisans WHERE id=$1', [userId]
    );

    await generatePDF({
      artisan:          artisanResult.rows[0],
      numero:           devis.numero,
      numero_facture:   devis.numero_facture,
      reference_bien:   devis.reference_bien,
      client_nom:       devis.client_nom,
      client_telephone: devis.client_telephone,
      objet:            devis.objet,
      type_travaux:     devis.type_travaux,
      lignes:           parseJson(devis.lignes),
      surfaces:         parseJson(devis.surfaces),
      main_oeuvre:      devis.main_oeuvre,
      acompte:          devis.acompte,
      totalHT:          devis.total,
      res
    });
  } catch (err) {
    console.error('[PDF]', err);
    if (!res.headersSent) res.status(500).json({ error: 'Erreur génération PDF' });
  }
});

// ✅ v4.5 : POST /api/devis/:id/share — génère code court 8 chars
app.post('/api/devis/:id/share', authMiddleware, async (req, res) => {
  try {
    const devisResult = await pool.query(
      'SELECT id, numero FROM devis WHERE id=$1 AND artisan_id=$2',
      [req.params.id, req.user.id]
    );
    if (!devisResult.rows.length) return res.status(404).json({ error: 'Devis introuvable' });

    // Réutiliser un code existant non expiré si disponible
    const existing = await pool.query(
      `SELECT id FROM devis_partages WHERE devis_id=$1 AND expires_at > NOW() LIMIT 1`,
      [req.params.id]
    );

    let shareCode;
    if (existing.rows.length) {
      shareCode = existing.rows[0].id;
    } else {
      // Générer un code unique
      let unique = false;
      while (!unique) {
        shareCode = makeShareCode();
        const check = await pool.query('SELECT id FROM devis_partages WHERE id=$1', [shareCode]);
        if (!check.rows.length) unique = true;
      }
      await pool.query(
        `INSERT INTO devis_partages (id, devis_id, artisan_id, expires_at, created_at)
         VALUES ($1,$2,$3,NOW() + INTERVAL '7 days',NOW())`,
        [shareCode, req.params.id, req.user.id]
      );
    }

    res.json({
      share_url:  `${BACKEND_URL}/d/${shareCode}`,
      code:       shareCode,
      expires_in: '7 jours'
    });
  } catch (err) {
    console.error('[SHARE]', err);
    res.status(500).json({ error: 'Erreur génération lien partage' });
  }
});

// ── PUT /api/devis/:id/marquer-paye ───────────────────────────
// Transforme un devis en facture : passe le statut à 'paye' et génère un
// numero_facture (`FACT-${Date.now()}`, même convention que `DEV-${Date.now()}`
// pour numero). Idempotent : si le devis a DÉJÀ un numero_facture, on renvoie
// l'existant sans rien régénérer — un double-clic ne crée jamais deux numéros.
app.put('/api/devis/:id/marquer-paye', authMiddleware, async (req, res) => {
  try {
    const devisResult = await pool.query(
      'SELECT id, numero_facture, facture_generee_le FROM devis WHERE id=$1 AND artisan_id=$2',
      [req.params.id, req.user.id]
    );
    if (!devisResult.rows.length) return res.status(404).json({ error: 'Devis introuvable' });

    const devis = devisResult.rows[0];
    if (devis.numero_facture) {
      return res.json({
        numero_facture:     devis.numero_facture,
        facture_generee_le: devis.facture_generee_le
      });
    }

    const numeroFacture = `FACT-${Date.now()}`;
    const updateResult  = await pool.query(
      `UPDATE devis SET statut='paye', numero_facture=$1, facture_generee_le=NOW()
       WHERE id=$2 AND artisan_id=$3
       RETURNING numero_facture, facture_generee_le`,
      [numeroFacture, req.params.id, req.user.id]
    );
    res.json({
      numero_facture:     updateResult.rows[0].numero_facture,
      facture_generee_le: updateResult.rows[0].facture_generee_le
    });
  } catch (err) {
    console.error('[MARQUER-PAYE]', err);
    res.status(500).json({ error: 'Erreur lors du passage en facture' });
  }
});

// ── POST /api/devis/:id/envoyer-email ─────────────────────────
// Envoi manuel du PDF du devis au client par email, via Brevo (API
// transactionnelle /v3/smtp/email, fetch natif — pas de SDK).
// Fonctionnalité optionnelle : si BREVO_API_KEY n'est pas configurée, la route
// répond 503 sans jamais empêcher le serveur de tourner.
app.post('/api/devis/:id/envoyer-email', emailLimiter, authMiddleware, async (req, res) => {
  try {
    const devisResult = await pool.query(
      'SELECT * FROM devis WHERE id=$1 AND artisan_id=$2',
      [req.params.id, req.user.id]
    );
    if (!devisResult.rows.length) return res.status(404).json({ error: 'Devis introuvable' });
    const devis = devisResult.rows[0];

    if (!devis.client_email) {
      return res.status(400).json({
        error: "Ce devis n'a pas d'email client. Ajoute une adresse email au client pour pouvoir lui envoyer le devis par mail."
      });
    }

    // BREVO_API_KEY / BREVO_SENDER_EMAIL absentes → fonctionnalité désactivée.
    const senderEmail = process.env.BREVO_SENDER_EMAIL;
    if (!process.env.BREVO_API_KEY || !senderEmail) {
      return res.status(503).json({ error: "Service d'email non configuré" });
    }
    const senderName = process.env.BREVO_SENDER_NAME || 'DevisPro CI';

    const artisanResult = await pool.query(
      'SELECT id, nom, prenom, telephone, metier, nom_entreprise FROM artisans WHERE id=$1', [req.user.id]
    );
    const artisan    = artisanResult.rows[0];
    const artisanNom = `${artisan.nom} ${artisan.prenom || ''}`.trim();
    const totalTxt   = `${fcfa(devis.total)} FCFA`;

    // PDF en Buffer (fonction commune) → base64 pour la pièce jointe Brevo,
    // sans repasser par une requête HTTP interne.
    const pdfBuffer = await buildDevisPDF({
      artisan,
      numero:           devis.numero,
      numero_facture:   devis.numero_facture,
      reference_bien:   devis.reference_bien,
      client_nom:       devis.client_nom,
      client_telephone: devis.client_telephone,
      objet:            devis.objet,
      type_travaux:     devis.type_travaux,
      lignes:           parseJson(devis.lignes),
      surfaces:         parseJson(devis.surfaces),
      main_oeuvre:      devis.main_oeuvre,
      acompte:          devis.acompte,
      totalHT:          devis.total
    });
    const pdfBase64 = pdfBuffer.toString('base64');

    const textContent =
      `Bonjour ${devis.client_nom},\n\n` +
      `Veuillez trouver ci-joint votre devis ${devis.numero} d'un montant de ${totalTxt}.\n\n` +
      `Ce devis est valable 30 jours à compter de sa date d'émission.\n\n` +
      `Cordialement,\n${artisanNom}\n${artisan.metier}\nTél : ${artisan.telephone}`;
    const htmlContent =
      `<p>Bonjour ${devis.client_nom},</p>` +
      `<p>Veuillez trouver ci-joint votre devis <strong>${devis.numero}</strong> ` +
      `d'un montant de <strong>${totalTxt}</strong>.</p>` +
      `<p>Ce devis est valable 30 jours à compter de sa date d'émission.</p>` +
      `<p>Cordialement,<br>${artisanNom}<br>${artisan.metier}<br>Tél : ${artisan.telephone}</p>`;

    let brevoRes, brevoData;
    try {
      brevoRes = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'accept':       'application/json',
          'api-key':      process.env.BREVO_API_KEY
        },
        body: JSON.stringify({
          sender:      { email: senderEmail, name: senderName },
          to:          [{ email: devis.client_email, name: devis.client_nom }],
          subject:     `Votre devis ${devis.numero} — ${artisanNom}`,
          textContent,
          htmlContent,
          attachment:  [{ content: pdfBase64, name: `devis-${devis.numero}.pdf` }]
        })
      });
      brevoData = await brevoRes.json().catch(() => ({}));
    } catch (netErr) {
      console.error('[EMAIL] Échec réseau vers Brevo :', netErr.message);
      return res.status(502).json({ error: "Impossible de joindre le service d'email. Réessaie plus tard." });
    }

    if (!brevoRes.ok) {
      console.error('[EMAIL] Brevo a répondu en échec :', brevoRes.status, JSON.stringify(brevoData));
      return res.status(502).json({ error: "L'envoi de l'email a échoué. Vérifie l'adresse du client ou réessaie plus tard." });
    }

    await pool.query(`UPDATE devis SET statut='envoye' WHERE id=$1 AND statut='brouillon'`, [devis.id]);
    console.log(`[EMAIL] Devis ${devis.numero} envoyé à ${devis.client_email} (messageId: ${brevoData.messageId || 'n/a'})`);
    res.json({ success: true });
  } catch (err) {
    console.error('[EMAIL]', err);
    res.status(500).json({ error: "Erreur lors de l'envoi de l'email" });
  }
});

// ✅ v4.5 : GET /d/:code — lien court public, affiche le PDF
app.get('/d/:code', async (req, res) => {
  try {
    const partageResult = await pool.query(
      `SELECT dp.*, d.*, a.nom, a.prenom, a.telephone, a.metier, a.nom_entreprise
       FROM devis_partages dp
       JOIN devis d ON dp.devis_id = d.id
       JOIN artisans a ON dp.artisan_id = a.id
       WHERE dp.id=$1 AND dp.expires_at > NOW()`,
      [req.params.code.toUpperCase()]
    );

    if (!partageResult.rows.length) {
      return res.status(410).send(`
        <html><body style="font-family:sans-serif;text-align:center;padding:60px">
          <h2>Lien expiré ou invalide</h2>
          <p>Ce devis n'est plus disponible.</p>
        </body></html>
      `);
    }

    const row     = partageResult.rows[0];
    const artisan = { id: row.artisan_id, nom: row.nom, prenom: row.prenom, telephone: row.telephone, metier: row.metier, nom_entreprise: row.nom_entreprise };

    await generatePDF({
      artisan,
      numero:           row.numero,
      numero_facture:   row.numero_facture,
      reference_bien:   row.reference_bien,
      client_nom:       row.client_nom,
      client_telephone: row.client_telephone,
      objet:            row.objet,
      type_travaux:     row.type_travaux,
      lignes:           parseJson(row.lignes),
      surfaces:         parseJson(row.surfaces),
      main_oeuvre:      row.main_oeuvre,
      acompte:          row.acompte,
      totalHT:          row.total,
      res
    });
  } catch (err) {
    console.error('[/d/]', err);
    if (!res.headersSent) res.status(500).send('Erreur serveur');
  }
});

app.get('/api/devis', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, numero, numero_facture, client_nom, client_telephone, client_email, reference_bien, objet, total, statut, pdf_url, created_at
       FROM devis WHERE artisan_id=$1 ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.get('/api/devis/:id', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM devis WHERE id=$1 AND artisan_id=$2',
      [req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Devis introuvable' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

// ══════════════════════════════════════════════════════════════
// ROUTE BOT
// ══════════════════════════════════════════════════════════════

app.post('/api/bot/message', authMiddleware, async (req, res) => {
  const { message, history, devis_draft } = req.body;

  // [FIX #7 - 27/07/2026] Avant, `history` était réinjecté tel quel dans l'appel
  // Mistral — un artisan avec un plan payant (donc sans quota) pouvait fabriquer un
  // historique avec des rôles arbitraires ou démesurément long pour détourner
  // l'endpoint ou faire exploser la consommation de l'API Mistral.
  if (!message || typeof message !== 'string' || message.length > 2000) {
    return res.status(400).json({ error: 'Message invalide ou trop long (2000 caractères max)' });
  }
  if (history && !Array.isArray(history)) {
    return res.status(400).json({ error: 'Historique invalide' });
  }
  // On exclut aussi les messages au contenu vide (pas seulement les rôles
  // invalides ou trop longs) : le frontend a pu pousser une fois un message
  // assistant vide (si `clean` était vide à un tour précédent). Réinjecté tel
  // quel, il faisait échouer l'appel Mistral suivant avec l'erreur "Assistant
  // message must have either content or tool_calls, but not none" (code 3240,
  // observée en prod à deux reprises).
  const safeHistory = (history || []).slice(-20).filter(h =>
    h && (h.role === 'user' || h.role === 'assistant') &&
    typeof h.content === 'string' && h.content.trim().length > 0 &&
    h.content.length <= 2000
  );

  try {
    const artisanResult = await pool.query(
      'SELECT nom, metier, plan, devis_count, statut FROM artisans WHERE id=$1', [req.user.id]
    );
    const artisan = artisanResult.rows[0];

    if (artisan.statut === 'suspendu') {
      return res.status(403).json({ error: "Votre abonnement a expiré. Contactez l'administrateur." });
    }
    if (artisan.plan === 'gratuit' && artisan.devis_count >= 3) {
      return res.json({
        reply: `🔒 Vous avez utilisé vos 3 devis gratuits.\n\nAbonnez-vous au plan Starter (1 000 FCFA/mois) via Wave CI ou Orange Money.\n\nContactez l'administrateur par WhatsApp pour activer votre abonnement.`,
        action: null,
        quota_depasse: true
      });
    }

    const devisRestants = artisan.plan === 'gratuit'
      ? ` [${3 - artisan.devis_count} devis gratuit${3 - artisan.devis_count > 1 ? 's' : ''} restant${3 - artisan.devis_count > 1 ? 's' : ''}]`
      : '';

    const systemPrompt = `Tu es DevisPro, un assistant pour artisans en Côte d'Ivoire.
Tu aides ${artisan.nom} (${artisan.metier}) à créer des devis professionnels.
Tu poses UNE question à la fois, de manière simple et directe.${devisRestants}

WORKFLOW :
1. Demande le nom du client
2. Demande le numéro de téléphone du client (pour WhatsApp). Si pas de numéro, note null.
3. Demande l'email du client : "As-tu l'email du client ? (facultatif, dis 'non' si tu ne l'as pas)". Si pas d'email, note null. Ne JAMAIS bloquer la création du devis parce que l'email manque.
4. Demande le type de travaux
5. Si carrelage/peinture/faux plafond : propose calcul de surface (longueur × largeur, pièce par pièce)
6. Pour chaque fourniture : désignation → quantité → unité → prix unitaire → confirme → "Autre fourniture ?"
7. Demande le coût de la main-d'œuvre
8. Demande si un acompte est souhaité
9. Résume et demande confirmation

RÈGLES ABSOLUES :
- Français simple, comme on parle à Abidjan
- UNE question par réponse
- PAS de markdown : pas de **, pas de ###, pas de tirets — texte brut uniquement
- L'email du client est FACULTATIF : si l'artisan dit "non" / "pas d'email" / laisse vide, mets client_email à null et continue normalement
- Ne saute JAMAIS l'étape 3 (demande de l'email du client) même si la conversation part sur un autre sujet ou si l'artisan répond de façon inattendue — reviens-y avant de passer à l'étape suivante si elle n'a pas encore été posée.

MÉMOIRE DU DEVIS (OBLIGATOIRE À CHAQUE QUESTION) :
- TANT QUE le devis n'est pas confirmé et finalisé — c'est-à-dire à chaque fois que tu poses une question, et JAMAIS sur la réponse finale create_devis — termine ta réponse par un bloc cumulatif, seul sur une nouvelle ligne, au format EXACT (une seule ligne, aucun espace ni retour à l'intérieur) :
<<<DRAFT>>>{"client_nom":"...ou null","client_telephone":"...ou null","client_email":"...ou null","type_travaux":"...ou null","lignes":[{"designation":"...","quantite":0,"unite":"...","prix_unitaire":0}],"main_oeuvre":0,"acompte":0}<<<END>>>
- Ce bloc doit refléter la TOTALITÉ de ce qui est déjà connu du devis à ce stade de la conversation, pas seulement la dernière réponse de l'artisan. Mets null pour chaque champ texte non encore renseigné, [] pour "lignes" tant qu'aucune fourniture n'a été notée, 0 pour "main_oeuvre" et "acompte" non encore renseignés.
- Le contenu de ce bloc est repris TEL QUEL, plus bas dans ce prompt, sous "ÉTAT ACTUEL DU DEVIS". Pars TOUJOURS de cet état déjà connu et complète-le avec la nouvelle information : ne repars jamais de zéro, ne perds jamais une donnée (nom, téléphone, fourniture déjà notée...) déjà présente dans "ÉTAT ACTUEL DU DEVIS".
- Ne remets JAMAIS à null un champ qui a déjà une valeur connue dans "ÉTAT ACTUEL DU DEVIS", même si la conversation dévie du WORKFLOW prévu (ex : l'artisan enchaîne directement sur le type de travaux ou les fournitures) — recopie systématiquement les valeurs déjà connues.
- L'artisan ne voit jamais ce bloc (il est retiré automatiquement avant l'affichage). N'y fais aucune référence dans ta phrase.
- Ce bloc n'apparaît QUE sur les questions. Sur la réponse finale, ta réponse est UNIQUEMENT le JSON de confirmation (voir plus bas), rien d'autre (ni bloc <<<DRAFT>>>, ni texte autour).

- Quand le devis est complet et CONFIRMÉ par l'artisan (il a répondu "oui" ou équivalent à la question de confirmation), réponds UNIQUEMENT avec ce JSON EXACT, rien avant, rien après, pas de backticks, pas de bloc <<<DRAFT>>> :
{"action":"devis_confirme"}
Tu n'as PAS besoin de re-décrire le devis à ce moment-là — l'état déjà connu (ÉTAT ACTUEL DU DEVIS ci-dessus) est utilisé tel quel.
- Pour les surfaces, calcule longueur × largeur et propose +10% pour chutes

ÉTAT ACTUEL DU DEVIS :
${JSON.stringify(devis_draft || {}, null, 2)}`;

    const messages = [
      ...safeHistory.map(h => ({ role: h.role, content: h.content })),
      { role: 'user', content: message }
    ];

    const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.MISTRAL_API_KEY}` },
      body: JSON.stringify({
        model: 'mistral-large-latest',
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        temperature: 0.3, max_tokens: 600
      })
    });

    const data  = await response.json();
    if (!data.choices || !data.choices[0]) {
      console.error('[BOT] Réponse Mistral invalide :', JSON.stringify(data));
      return res.status(500).json({ error: "Le service de génération de devis a rencontré un problème. Réessaie." });
    }
    const raw   = data.choices[0].message.content.trim();

    // ── Bloc mémoire <<<DRAFT>>>...<<<END>>> ─────────────────────
    // Le prompt système demande à l'IA de terminer chaque QUESTION (jamais la
    // réponse finale create_devis) par un bloc JSON reflétant TOUT l'état connu
    // du devis. Ce bloc — pas l'historique brut, plafonné à 20 messages par
    // safeHistory.slice(-20) — porte la mémoire structurée : on le parse, on le
    // renvoie au frontend dans `draft`, et on le retire du texte affiché.
    let draft = null;
    const draftMatch = raw.match(/<<<DRAFT>>>([\s\S]*?)<<<END>>>/);
    if (draftMatch) {
      try {
        draft = JSON.parse(draftMatch[1].trim());
      } catch (parseErr) {
        // Bloc mal formé : on log et on l'ignore, sans jamais faire échouer la route.
        console.error('[BOT] Bloc <<<DRAFT>>> mal formé, ignoré :', parseErr.message);
        draft = null;
      }
    }

    // Texte visible = réponse brute privée du bloc (et des espaces/retours
    // autour) ; c'est lui qu'on nettoie du markdown, qu'on affiche et qu'on
    // analyse pour détecter le JSON create_devis.
    const rawVisible = raw.replace(/\s*<<<DRAFT>>>[\s\S]*?<<<END>>>\s*/g, '').trim();
    const clean = rawVisible.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    // ── Détection du signal de confirmation (Piste 1) ─────────
    // L'IA n'émet plus le JSON create_devis complet — juste
    // {"action":"devis_confirme"}. C'est le CODE qui assemble ensuite le
    // payload à partir de devis_draft (source de vérité) : on supprime ainsi
    // la 4e représentation LLM du devis et la divergence qu'elle causait.
    let confirme = false;
    try {
      const parsed = JSON.parse(clean);
      if (parsed && parsed.action === 'devis_confirme') confirme = true;
    } catch {
      try {
        const jsonMatch = clean.match(/\{[\s\S]*"action"\s*:\s*"devis_confirme"[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed && parsed.action === 'devis_confirme') confirme = true;
        }
      } catch {}
    }

    if (confirme) {
      const draftOk  = devis_draft && typeof devis_draft === 'object' && !Array.isArray(devis_draft);
      const nomOk    = draftOk && typeof devis_draft.client_nom === 'string' && devis_draft.client_nom.trim() !== '';
      const lignesOk = draftOk && Array.isArray(devis_draft.lignes) && devis_draft.lignes.length > 0;

      if (!nomOk || !lignesOk) {
        // État incomplet côté serveur → relance polie, jamais une erreur.
        const manque = [];
        if (!nomOk)    manque.push('le nom du client');
        if (!lignesOk) manque.push('au moins une fourniture');
        return res.json({
          reply:  `Il manque encore ${manque.join(' et ')}. Complète le devis avant de confirmer.`,
          action: null,
          draft
        });
      }

      // Le CODE construit le payload à partir de devis_draft. On garde le nom
      // "create_devis" dans l'action renvoyée au frontend pour ne rien casser
      // dans bot.js (détection de finalAction) : seul le signal reçu de l'IA a
      // changé de nom, pas le contrat avec le frontend.
      const action = {
        action: 'create_devis',
        data: {
          client_nom:       devis_draft.client_nom,
          client_telephone: devis_draft.client_telephone,
          client_email:     devis_draft.client_email,
          type_travaux:     devis_draft.type_travaux,
          lignes:           devis_draft.lignes || [],
          surfaces:         [],
          main_oeuvre:      devis_draft.main_oeuvre || 0,
          acompte:          devis_draft.acompte || 0
        }
      };
      return res.json({ reply: '✅ Parfait ! Je prépare ton devis...', action, draft });
    }

    // Défense en profondeur à la source : ne jamais renvoyer une réponse vide
    // au frontend (qui la repousserait ensuite comme message assistant vide
    // dans l'historique — cf. filtre safeHistory / erreur Mistral 3240).
    // Indépendant de ce filtre : on corrige ici, au point d'émission.
    let replyText = clean;
    if (replyText.trim().length === 0) {
      replyText = "Je n'ai pas bien compris, peux-tu reformuler ?";
    }

    res.json({ reply: replyText, action: null, draft });

  } catch (err) {
    console.error('[BOT]', err);
    res.status(500).json({ error: 'Erreur IA' });
  }
});

// ══════════════════════════════════════════════════════════════
// ROUTE PHOTO / PIXTRAL
// ══════════════════════════════════════════════════════════════

app.post('/api/bot/photo', authMiddleware, async (req, res) => {
  // Défense en profondeur : l'analyse photo n'a de sens que pour les métiers
  // bâtiment/surface. Le bouton est déjà masqué côté frontend pour les autres,
  // mais on refuse aussi ici au cas où la requête serait forgée.
  try {
    const metierResult = await pool.query('SELECT metier FROM artisans WHERE id=$1', [req.user.id]);
    const artisan = metierResult.rows[0];
    if (!artisan || !isMetierEligiblePhoto(artisan.metier)) {
      return res.status(403).json({
        type: 'indisponible',
        message: "L'analyse photo n'est pas encore disponible pour ton métier. Décris ta demande par message, je peux t'aider directement."
      });
    }
  } catch (err) {
    console.error('[PHOTO] Vérification métier échouée :', err.message);
    return res.status(500).json({ error: "Erreur lors de l'analyse de la photo" });
  }

  const { image } = req.body;
  if (!image) return res.status(400).json({ error: 'Image manquante' });

  const base64Data = image.replace(/^data:image\/[a-z]+;base64,/, '');
  const mimeMatch  = image.match(/^data:(image\/[a-z]+);base64,/);
  const mimeType   = mimeMatch ? mimeMatch[1] : 'image/jpeg';

  const systemPrompt = `Tu es un assistant pour artisans en Côte d'Ivoire. Analyse l'image et retourne UNIQUEMENT un JSON valide.
Si PIÈCE : {"type":"piece","piece_detectee":"Salon","dimensions_estimees":{"longueur":4.5,"largeur":3.0},"surface_estimee":13.5,"confiance":"moyenne","notes":"","type_travaux_suggere":"carrelage"}
Si DOCUMENT/FACTURE : {"type":"document","lignes":[{"designation":"Carrelage 60x60","quantite":15,"unite":"m²","prix_unitaire":3500}],"fournisseur":"","total_document":0,"notes":""}
Sinon : {"type":"inconnu","message":"Je ne peux pas analyser cette image."}
IMPORTANT : JSON seulement, rien d'autre.`;

  try {
    const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.MISTRAL_API_KEY}` },
      body: JSON.stringify({
        model: 'pixtral-large-latest',
        messages: [{ role: 'user', content: [
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Data}` } },
          { type: 'text', text: systemPrompt }
        ]}],
        temperature: 0.1, max_tokens: 800
      })
    });
    const data = await response.json();
    if (!data.choices || !data.choices[0]) return res.status(500).json({ error: 'Réponse Pixtral invalide' });
    const raw = data.choices[0].message.content.trim();
    try {
      res.json(JSON.parse(raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()));
    } catch {
      res.json({ type: 'inconnu', message: "Je n'ai pas pu analyser l'image. Réessaie avec une photo plus nette." });
    }
  } catch (err) {
    console.error('[PHOTO]', err);
    res.status(500).json({ error: "Erreur lors de l'analyse de la photo" });
  }
});

// ══════════════════════════════════════════════════════════════
// ROUTES ADMIN
// ══════════════════════════════════════════════════════════════

app.post('/api/admin/login', authLimiter, (req, res) => {
  const { password } = req.body;
  // [FIX #2 - 27/07/2026] Fallback en dur supprimé (ADMIN_PASSWORD est maintenant
  // obligatoire au démarrage, voir vérification en haut du fichier)
  if (password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Mot de passe incorrect' });
  const token = jwt.sign({ admin: true }, process.env.JWT_SECRET, { expiresIn: '8h' });
  res.json({ token });
});

app.get('/api/admin/stats', adminAuth, async (req, res) => {
  try {
    const [artisans, devis, ca, plans, devis7j, artisans7j] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM artisans'),
      pool.query('SELECT COUNT(*) FROM devis'),
      pool.query('SELECT COALESCE(SUM(total),0) AS total FROM devis'),
      pool.query('SELECT plan, COUNT(*) as count FROM artisans GROUP BY plan ORDER BY count DESC'),
      pool.query(`SELECT COUNT(*) FROM devis WHERE created_at >= NOW() - INTERVAL '7 days'`),
      pool.query(`SELECT COUNT(*) FROM artisans WHERE created_at >= NOW() - INTERVAL '7 days'`)
    ]);
    res.json({
      total_artisans:   parseInt(artisans.rows[0].count),
      total_devis:      parseInt(devis.rows[0].count),
      chiffre_affaires: parseInt(ca.rows[0].total),
      devis_7j:         parseInt(devis7j.rows[0].count),
      artisans_7j:      parseInt(artisans7j.rows[0].count),
      plans:            plans.rows
    });
  } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.get('/api/admin/artisans', adminAuth, async (req, res) => {
  const page   = parseInt(req.query.page) || 1, limit = 20, offset = (page - 1) * limit;
  const search = req.query.search ? `%${req.query.search}%` : '%';
  try {
    const [rows, total] = await Promise.all([
      pool.query(
        `SELECT id,nom,prenom,telephone,metier,plan,devis_count,statut,expires_at,created_at
         FROM artisans WHERE nom ILIKE $1 OR telephone ILIKE $1 OR metier ILIKE $1
         ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [search, limit, offset]
      ),
      pool.query(
        'SELECT COUNT(*) FROM artisans WHERE nom ILIKE $1 OR telephone ILIKE $1 OR metier ILIKE $1',
        [search]
      )
    ]);
    res.json({ artisans: rows.rows, total: parseInt(total.rows[0].count), page, limit });
  } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.put('/api/admin/artisans/:id/plan', adminAuth, async (req, res) => {
  const { plan } = req.body;
  if (!['gratuit', 'starter', 'pro'].includes(plan)) return res.status(400).json({ error: 'Plan invalide' });
  try { await pool.query('UPDATE artisans SET plan=$1 WHERE id=$2', [plan, req.params.id]); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.put('/api/admin/artisans/:id/statut', adminAuth, async (req, res) => {
  const { statut } = req.body;
  if (!['en_attente', 'actif', 'suspendu'].includes(statut)) return res.status(400).json({ error: 'Statut invalide' });
  try { await pool.query('UPDATE artisans SET statut=$1 WHERE id=$2', [statut, req.params.id]); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.put('/api/admin/artisans/:id/renouveler', adminAuth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE artisans SET statut='actif', expires_at=NOW() + INTERVAL '30 days' WHERE id=$1`,
      [req.params.id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.delete('/api/admin/artisans/:id', adminAuth, async (req, res) => {
  try { await pool.query('DELETE FROM artisans WHERE id=$1', [req.params.id]); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.get('/api/admin/devis', adminAuth, async (req, res) => {
  const page   = parseInt(req.query.page) || 1, limit = 20, offset = (page - 1) * limit;
  const search = req.query.search ? `%${req.query.search}%` : '%';
  try {
    const [rows, total] = await Promise.all([
      pool.query(
        `SELECT d.id,d.numero,d.client_nom,d.objet,d.total,d.statut,d.created_at,
                a.nom as artisan_nom, a.telephone as artisan_tel
         FROM devis d JOIN artisans a ON d.artisan_id=a.id
         WHERE d.client_nom ILIKE $1 OR d.numero ILIKE $1 OR a.nom ILIKE $1
         ORDER BY d.created_at DESC LIMIT $2 OFFSET $3`,
        [search, limit, offset]
      ),
      pool.query(
        `SELECT COUNT(*) FROM devis d JOIN artisans a ON d.artisan_id=a.id
         WHERE d.client_nom ILIKE $1 OR d.numero ILIKE $1 OR a.nom ILIKE $1`,
        [search]
      )
    ]);
    res.json({ devis: rows.rows, total: parseInt(total.rows[0].count), page, limit });
  } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.get('/api/admin/logs', adminAuth, async (req, res) => {
  try {
    const alerts = await pool.query(
      `SELECT 'Devis sans PDF' as type, COUNT(*) as count, MAX(created_at) as last_seen
         FROM devis WHERE pdf_url IS NULL AND created_at > NOW() - INTERVAL '24h'
       UNION ALL
       SELECT 'Artisans en attente', COUNT(*), MAX(created_at)
         FROM artisans WHERE statut='en_attente'
       UNION ALL
       SELECT 'Codes non utilisés', COUNT(*), MAX(created_at)
         FROM activation_codes WHERE used=false
       UNION ALL
       SELECT 'Abonnements expirés sous 3j', COUNT(*), MAX(expires_at)
         FROM artisans WHERE statut='actif' AND plan != 'gratuit'
           AND expires_at IS NOT NULL
           AND expires_at BETWEEN NOW() AND NOW() + INTERVAL '3 days'`
    );
    res.json({ status: 'ok', db_connected: true, uptime: process.uptime(), memory: process.memoryUsage(), alerts: alerts.rows });
  } catch (err) { res.status(500).json({ error: 'Erreur serveur', db_connected: false }); }
});

app.post('/api/admin/codes/generate', adminAuth, async (req, res) => {
  const { count = 1 } = req.body;
  const n = Math.min(Math.max(parseInt(count) || 1, 1), 50);
  const generated = [];
  try {
    for (let i = 0; i < n; i++) {
      const code   = makeActivationCode();
      const result = await pool.query(
        `INSERT INTO activation_codes (id,code,artisan_id,used,created_at) VALUES ($1,$2,null,false,NOW()) RETURNING *`,
        [uuidv4(), code]
      );
      generated.push(result.rows[0]);
    }
    res.status(201).json({ generated, count: generated.length });
  } catch (err) { console.error('[CODES]', err); res.status(500).json({ error: 'Erreur génération' }); }
});

app.get('/api/admin/codes', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ac.*, a.nom as artisan_nom, a.telephone as artisan_tel
       FROM activation_codes ac LEFT JOIN artisans a ON ac.artisan_id=a.id
       ORDER BY ac.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.delete('/api/admin/codes/:id', adminAuth, async (req, res) => {
  try { await pool.query('DELETE FROM activation_codes WHERE id=$1', [req.params.id]); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

// ══════════════════════════════════════════════════════════════
// HEALTH CHECK
// ══════════════════════════════════════════════════════════════
app.get('/health', (req, res) => res.json({ status: 'ok', app: 'DevisPro CI', version: '4.6.0' }));

// ══════════════════════════════════════════════════════════════
// HANDLER D'ERREURS GÉNÉRIQUE (JSON)
// ══════════════════════════════════════════════════════════════
// [FIX #1 + #4 - 27/07/2026] Attrape les erreurs multer (upload malformé, type de
// fichier refusé) et CORS pour renvoyer une réponse JSON propre au lieu de laisser
// Express planter ou renvoyer une page HTML par défaut.
app.use((err, req, res, next) => {
  if (err && err.name === 'MulterError') {
    return res.status(400).json({ error: `Erreur upload : ${err.message}` });
  }
  if (err && err.message === 'Origine non autorisée par CORS') {
    return res.status(403).json({ error: 'Origine non autorisée' });
  }
  console.error('[UNHANDLED]', err);
  res.status(500).json({ error: 'Erreur serveur' });
});

app.listen(PORT, () => console.log(`DevisPro CI backend v4.6 running on port ${PORT}`));