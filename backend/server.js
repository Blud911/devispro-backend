// ══════════════════════════════════════════════════════════════
// DevisPro CI — server.js v4.3
// Node.js v24 : tous les require() en tête de fichier (règle critique)
// v4.3 : lien partage WhatsApp public 7j, vérif statut bot,
//        fix expires_at gratuit, fix stream PDF, normalisation JSON
// ══════════════════════════════════════════════════════════════
require('dotenv').config();

const express        = require('express');
const cors           = require('cors');
const rateLimit      = require('express-rate-limit');
const { Pool }       = require('pg');
const jwt            = require('jsonwebtoken');
const bcrypt         = require('bcryptjs');
const PDFDocument    = require('pdfkit');
const { v4: uuidv4 } = require('uuid');
const fs             = require('fs');
const path           = require('path');
const multer         = require('multer');

// ── App ────────────────────────────────────────────────────────
const app         = express();
const PORT        = process.env.PORT || 3000;
const BACKEND_URL = process.env.BACKEND_URL || 'https://blud911-devispro-backend.onrender.com';

// ── Middleware ─────────────────────────────────────────────────
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Rate limiting ──────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Trop de requêtes, réessaie dans 15 minutes.' }
});
app.use('/api/', limiter);

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
const upload = multer({ storage, limits: { fileSize: 2 * 1024 * 1024 } });

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

// ══════════════════════════════════════════════════════════════
// CRON QUOTIDIEN — expire les artisans abonnés non réabonnés
// ✅ v4.3 : plan gratuit ignoré (pas d'expires_at)
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
// GÉNÉRATEUR PDF — stream vers res (HTTP) uniquement
// ✅ v4.3 : Promise sur res 'finish' — plus de race condition
// ══════════════════════════════════════════════════════════════
function generatePDF({ artisan, numero, client_nom, client_telephone, objet, type_travaux, lignes, surfaces, main_oeuvre, acompte, totalHT, res }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="devis-${numero}.pdf"`);
    doc.pipe(res);

    res.on('finish', resolve);
    res.on('error',  reject);

    const BLUE = '#1A3A5C', GOLD = '#C9952B', GRAY = '#F5F5F5',
          WHITE = '#FFFFFF', DARK = '#1C1C1C', pageW = 495;

    // ── En-tête ───────────────────────────────────────────────
    doc.rect(0, 0, 595, 90).fill(BLUE);
    doc.fillColor(WHITE).fontSize(22).font('Helvetica-Bold').text('DevisPro CI', 50, 20);
    doc.fontSize(10).font('Helvetica')
       .text(`${artisan.nom} ${artisan.prenom || ''} — ${artisan.metier}`, 50, 48)
       .text(`Tél : ${artisan.telephone}`, 50, 62);
    doc.fillColor(GOLD).fontSize(10).font('Helvetica-Bold')
       .text(numero, 400, 30, { align: 'right', width: 145 });
    doc.fillColor(WHITE).font('Helvetica').fontSize(9)
       .text(`Date : ${new Date().toLocaleDateString('fr-FR')}`, 400, 48, { align: 'right', width: 145 })
       .text('Validité : 30 jours', 400, 62, { align: 'right', width: 145 });

    // ── Bloc client ───────────────────────────────────────────
    doc.rect(50, 105, pageW, 60).fill(GRAY);
    doc.fillColor(BLUE).fontSize(9).font('Helvetica-Bold').text('CLIENT', 60, 112);
    doc.fillColor(DARK).font('Helvetica').fontSize(11).text(client_nom, 60, 126);
    if (client_telephone) doc.fontSize(9).fillColor('#555555').text(`Tél : ${client_telephone}`, 60, 142);
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
       Number(l.prix_unitaire).toLocaleString('fr-FR'),
       Number(total).toLocaleString('fr-FR')].forEach((c, i) => {
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
         .text(Number(main_oeuvre).toLocaleString('fr-FR'), colX[4], y + 6, { width: colW[4], align: 'center' });
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
      if (isTotal) doc.rect(360, y - 2, pageW - 310, 22).fill(BLUE);
      doc.fillColor(isTotal ? WHITE : DARK)
         .font(isTotal ? 'Helvetica-Bold' : 'Helvetica')
         .fontSize(isTotal ? 11 : 9)
         .text(label, 365, y + (isTotal ? 5 : 2), { width: 120 })
         .text(`${Number(val).toLocaleString('fr-FR')} FCFA`, 490, y + (isTotal ? 5 : 2), { width: 50, align: 'right' });
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

// ══════════════════════════════════════════════════════════════
// ROUTES AUTH
// ══════════════════════════════════════════════════════════════

// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
  const { nom, prenom, telephone, metier, password } = req.body;
  if (!nom || !telephone || !metier || !password) {
    return res.status(400).json({ error: 'Champs obligatoires manquants' });
  }
  try {
    const hash   = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO artisans (id, nom, prenom, telephone, metier, password_hash, devis_count, statut, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,0,'en_attente',NOW()) RETURNING id`,
      [uuidv4(), nom, prenom || '', telephone, metier, hash]
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

// POST /api/auth/login
// ✅ v4.3 : vérif expires_at uniquement pour plan != gratuit
app.post('/api/auth/login', async (req, res) => {
  const { telephone, password } = req.body;
  try {
    const result  = await pool.query('SELECT * FROM artisans WHERE telephone = $1', [telephone]);
    const artisan = result.rows[0];
    if (!artisan) return res.status(401).json({ error: 'Numéro ou mot de passe incorrect' });

    const valid = await bcrypt.compare(password, artisan.password_hash);
    if (!valid) return res.status(401).json({ error: 'Numéro ou mot de passe incorrect' });

    // Expiration uniquement pour abonnés payants
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
        id:          artisan.id,
        nom:         artisan.nom,
        telephone:   artisan.telephone,
        metier:      artisan.metier,
        plan:        artisan.plan,
        devis_count: artisan.devis_count,
        statut:      artisan.statut,
        expires_at:  artisan.expires_at
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/auth/activate
app.post('/api/auth/activate', authMiddleware, async (req, res) => {
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
      'SELECT id, nom, prenom, telephone, metier, logo_url, devis_count, plan, statut, expires_at FROM artisans WHERE id=$1',
      [req.user.id]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.put('/api/profil', authMiddleware, async (req, res) => {
  const { nom, prenom, telephone, metier } = req.body;
  try {
    await pool.query(
      'UPDATE artisans SET nom=$1, prenom=$2, telephone=$3, metier=$4 WHERE id=$5',
      [nom, prenom, telephone, metier, req.user.id]
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

// POST /api/devis
app.post('/api/devis', authMiddleware, async (req, res) => {
  const { client_nom, client_telephone, objet, type_travaux, lignes, main_oeuvre, acompte, surfaces } = req.body;
  if (!client_nom || !lignes || !lignes.length) {
    return res.status(400).json({ error: 'Données incomplètes' });
  }
  try {
    const artisanResult = await pool.query('SELECT * FROM artisans WHERE id=$1', [req.user.id]);
    const artisan = artisanResult.rows[0];

    if (artisan.plan === 'gratuit' && artisan.devis_count >= 3) {
      return res.status(403).json({ error: 'Quota gratuit atteint.', quota_depasse: true });
    }

    // ✅ v4.3 : vérif statut suspendu avant création
    if (artisan.statut === 'suspendu') {
      return res.status(403).json({ error: "Votre abonnement a expiré. Contactez l'administrateur." });
    }

    const totalFournitures = lignes.reduce((sum, l) => sum + (l.quantite * l.prix_unitaire), 0);
    const totalHT  = totalFournitures + (main_oeuvre || 0);
    const numero   = `DEV-${Date.now()}`;
    const devisId  = uuidv4();
    const pdfUrl   = `${BACKEND_URL}/api/devis/${devisId}/pdf`;

    await pool.query(
      `INSERT INTO devis (id, artisan_id, numero, client_nom, client_telephone, objet,
        type_travaux, lignes, surfaces, main_oeuvre, acompte, total, statut, pdf_url, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'envoye',$13,NOW())`,
      [devisId, req.user.id, numero, client_nom, client_telephone || '', objet || '',
       type_travaux || '', JSON.stringify(lignes), JSON.stringify(surfaces || []),
       main_oeuvre || 0, acompte || 0, totalHT, pdfUrl]
    );

    for (const l of lignes) {
      await pool.query(
        `INSERT INTO tarifs (id, artisan_id, designation, unite, prix_unitaire, usage_count)
         VALUES ($1,$2,$3,$4,$5,1)
         ON CONFLICT (artisan_id, designation)
         DO UPDATE SET prix_unitaire=$5, usage_count=tarifs.usage_count+1`,
        [uuidv4(), req.user.id, l.designation, l.unite || 'unité', l.prix_unitaire]
      );
    }

    await pool.query('UPDATE artisans SET devis_count=devis_count+1 WHERE id=$1', [req.user.id]);

    res.status(201).json({ id: devisId, numero, total: totalHT, pdf_url: pdfUrl, message: `Devis ${numero} créé` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la création du devis' });
  }
});

// GET /api/devis/:id/pdf — génère et streame le PDF à la volée
// ✅ v4.3 : token en query param pour window.open(), Promise sur res finish
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
      'SELECT id, nom, prenom, telephone, metier FROM artisans WHERE id=$1', [userId]
    );
    const artisan = artisanResult.rows[0];

    await generatePDF({
      artisan,
      numero:           devis.numero,
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

// ✅ v4.3 : POST /api/devis/:id/share — génère token partage public 7j
app.post('/api/devis/:id/share', authMiddleware, async (req, res) => {
  try {
    const devisResult = await pool.query(
      'SELECT id, numero, client_nom, total FROM devis WHERE id=$1 AND artisan_id=$2',
      [req.params.id, req.user.id]
    );
    if (!devisResult.rows.length) return res.status(404).json({ error: 'Devis introuvable' });

    const devis      = devisResult.rows[0];
    const shareToken = jwt.sign(
      { devis_id: devis.id, artisan_id: req.user.id, share: true },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    const shareUrl = `${BACKEND_URL}/api/devis/view/${shareToken}`;

    res.json({ share_url: shareUrl, numero: devis.numero, expires_in: '7 jours' });
  } catch (err) {
    console.error('[SHARE]', err);
    res.status(500).json({ error: 'Erreur génération lien partage' });
  }
});

// ✅ v4.3 : GET /api/devis/view/:shareToken — PDF public via lien de partage
app.get('/api/devis/view/:shareToken', async (req, res) => {
  try {
    const decoded = jwt.verify(req.params.shareToken, process.env.JWT_SECRET);
    if (!decoded.share) return res.status(403).json({ error: 'Lien invalide' });

    const devisResult = await pool.query(
      'SELECT * FROM devis WHERE id=$1 AND artisan_id=$2',
      [decoded.devis_id, decoded.artisan_id]
    );
    if (!devisResult.rows.length) return res.status(404).json({ error: 'Devis introuvable' });

    const devis         = devisResult.rows[0];
    const artisanResult = await pool.query(
      'SELECT id, nom, prenom, telephone, metier FROM artisans WHERE id=$1',
      [decoded.artisan_id]
    );
    const artisan = artisanResult.rows[0];

    await generatePDF({
      artisan,
      numero:           devis.numero,
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
    console.error('[VIEW]', err);
    if (!res.headersSent) res.status(err.name === 'TokenExpiredError' ? 410 : 500)
      .json({ error: err.name === 'TokenExpiredError' ? 'Lien expiré' : 'Erreur serveur' });
  }
});

// GET /api/devis
app.get('/api/devis', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, numero, client_nom, objet, total, statut, pdf_url, created_at
       FROM devis WHERE artisan_id=$1 ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

// GET /api/devis/:id
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
// ✅ v4.3 : vérif statut suspendu avant appel Mistral
// ══════════════════════════════════════════════════════════════
app.post('/api/bot/message', authMiddleware, async (req, res) => {
  const { message, history, devis_draft } = req.body;
  try {
    const artisanResult = await pool.query(
      'SELECT nom, metier, plan, devis_count, statut FROM artisans WHERE id=$1', [req.user.id]
    );
    const artisan = artisanResult.rows[0];

    // ✅ Bloquer si suspendu même avec JWT encore valide
    if (artisan.statut === 'suspendu') {
      return res.status(403).json({ error: "Votre abonnement a expiré. Contactez l'administrateur." });
    }

    if (artisan.plan === 'gratuit' && artisan.devis_count >= 3) {
      return res.json({
        reply: `🔒 Vous avez utilisé vos 3 devis gratuits.\n\nAbonnez-vous au plan Starter (1 000 FCFA/mois) via Wave CI ou Orange Money.\n\nEnvoyez "STARTER" par WhatsApp au numéro de l'administrateur pour activer votre abonnement.`,
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
3. Demande le type de travaux
4. Si carrelage/peinture/faux plafond : propose calcul de surface (longueur × largeur, pièce par pièce)
5. Pour chaque fourniture : désignation → quantité → unité → prix unitaire → confirme → "Autre fourniture ?"
6. Demande le coût de la main-d'œuvre
7. Demande si un acompte est souhaité
8. Résume et demande confirmation

RÈGLES ABSOLUES :
- Français simple, comme on parle à Abidjan
- UNE question par réponse
- PAS de markdown dans tes réponses : pas de **, pas de ###, pas de listes à tirets — texte brut uniquement
- Quand le devis est complet et CONFIRMÉ, réponds UNIQUEMENT avec ce JSON EXACT (rien avant, rien après, pas de backticks) :
{"action":"create_devis","data":{"client_nom":"NOM","client_telephone":"TEL_OU_NULL","type_travaux":"TYPE","lignes":[{"designation":"NOM","quantite":0,"unite":"UNITE","prix_unitaire":0}],"surfaces":[],"main_oeuvre":0,"acompte":0}}
- Pour les surfaces, calcule longueur × largeur et propose +10% pour chutes

ÉTAT ACTUEL DU DEVIS :
${JSON.stringify(devis_draft || {}, null, 2)}`;

    const messages = [
      ...(history || []).map(h => ({ role: h.role, content: h.content })),
      { role: 'user', content: message }
    ];

    const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.MISTRAL_API_KEY}` },
      body: JSON.stringify({
        model:       'mistral-large-latest',
        messages:    [{ role: 'system', content: systemPrompt }, ...messages],
        temperature: 0.3,
        max_tokens:  600
      })
    });

    const data  = await response.json();
    const raw   = data.choices[0].message.content.trim();
    const clean = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    let action = null;
    try {
      const parsed = JSON.parse(clean);
      if (parsed.action === 'create_devis' && parsed.data) action = parsed;
    } catch {
      try {
        const jsonMatch = clean.match(/\{[\s\S]*"action"\s*:\s*"create_devis"[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed.action === 'create_devis' && parsed.data) action = parsed;
        }
      } catch {}
    }

    if (action) return res.json({ reply: '✅ Parfait ! Je génère ton devis...', action });
    res.json({ reply: clean, action: null });

  } catch (err) {
    console.error('[BOT]', err);
    res.status(500).json({ error: 'Erreur IA' });
  }
});

// ══════════════════════════════════════════════════════════════
// ROUTE PHOTO / PIXTRAL
// ══════════════════════════════════════════════════════════════

app.post('/api/bot/photo', authMiddleware, async (req, res) => {
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
        model:       'pixtral-large-latest',
        messages:    [{ role: 'user', content: [
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Data}` } },
          { type: 'text', text: systemPrompt }
        ]}],
        temperature: 0.1,
        max_tokens:  800
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

app.post('/api/admin/login', (req, res) => {
  const { password }     = req.body;
  const ADMIN_PASSWORD   = process.env.ADMIN_PASSWORD || 'devispro_admin_2026';
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Mot de passe incorrect' });
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
app.get('/health', (req, res) => res.json({ status: 'ok', app: 'DevisPro CI', version: '4.3.0' }));

app.listen(PORT, () => console.log(`DevisPro CI backend v4.3 running on port ${PORT}`));