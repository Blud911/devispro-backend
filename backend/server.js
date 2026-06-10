// ══════════════════════════════════════════════════════════════
// DevisPro CI — server.js
// Node.js v24 : tous les require() en tête de fichier (règle critique)
// ══════════════════════════════════════════════════════════════
require('dotenv').config();

const express      = require('express');
const cors         = require('cors');
const rateLimit    = require('express-rate-limit');
const { Pool }     = require('pg');
const jwt          = require('jsonwebtoken');
const bcrypt       = require('bcryptjs');
const PDFDocument  = require('pdfkit');
const { v4: uuidv4 } = require('uuid');
const fs           = require('fs');
const path         = require('path');
const multer       = require('multer');

// ── App ────────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ─────────────────────────────────────────────────
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/outputs', express.static(path.join(__dirname, 'outputs')));

// ── Rate limiting (express-rate-limit v5.5.1) ─────────────────
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

// ── Multer (upload logos) ──────────────────────────────────────
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
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO artisans (id, nom, prenom, telephone, metier, password_hash, devis_count, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,0,NOW()) RETURNING id, nom, telephone, metier`,
      [uuidv4(), nom, prenom || '', telephone, metier, hash]
    );
    const artisan = result.rows[0];
    const token = jwt.sign({ id: artisan.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.status(201).json({ token, artisan });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ce numéro est déjà inscrit' });
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  const { telephone, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM artisans WHERE telephone = $1', [telephone]);
    const artisan = result.rows[0];
    if (!artisan) return res.status(401).json({ error: 'Numéro ou mot de passe incorrect' });
    const valid = await bcrypt.compare(password, artisan.password_hash);
    if (!valid) return res.status(401).json({ error: 'Numéro ou mot de passe incorrect' });
    const token = jwt.sign({ id: artisan.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, artisan: { id: artisan.id, nom: artisan.nom, telephone: artisan.telephone, metier: artisan.metier } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ══════════════════════════════════════════════════════════════
// ROUTES PROFIL
// ══════════════════════════════════════════════════════════════

// GET /api/profil
app.get('/api/profil', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, nom, prenom, telephone, metier, logo_url, devis_count, plan FROM artisans WHERE id = $1',
      [req.user.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/profil
app.put('/api/profil', authMiddleware, async (req, res) => {
  const { nom, prenom, telephone, metier } = req.body;
  try {
    await pool.query(
      'UPDATE artisans SET nom=$1, prenom=$2, telephone=$3, metier=$4 WHERE id=$5',
      [nom, prenom, telephone, metier, req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/profil/logo
app.post('/api/profil/logo', authMiddleware, upload.single('logo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });
  const logoUrl = `/uploads/${req.file.filename}`;
  try {
    await pool.query('UPDATE artisans SET logo_url=$1 WHERE id=$2', [logoUrl, req.user.id]);
    res.json({ logo_url: logoUrl });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ══════════════════════════════════════════════════════════════
// ROUTES TARIFS (autocomplétion)
// ══════════════════════════════════════════════════════════════

// GET /api/tarifs?q=joint
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
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ══════════════════════════════════════════════════════════════
// ROUTES DEVIS
// ══════════════════════════════════════════════════════════════

// POST /api/devis — créer un devis et générer le PDF
app.post('/api/devis', authMiddleware, async (req, res) => {
  const {
    client_nom,
    client_telephone,
    objet,
    type_travaux,        // ex: "carrelage", "plomberie"
    lignes,              // [{ designation, quantite, unite, prix_unitaire }]
    main_oeuvre,
    acompte,
    surfaces             // [{ nom_piece, longueur, largeur, surface }] — optionnel
  } = req.body;

  if (!client_nom || !lignes || !lignes.length) {
    return res.status(400).json({ error: 'Données incomplètes' });
  }

  try {
    // ── Récupérer profil artisan ───────────────────────────────
    const artisanResult = await pool.query('SELECT * FROM artisans WHERE id=$1', [req.user.id]);
    const artisan = artisanResult.rows[0];

    // ── Calculer totaux ────────────────────────────────────────
    const totalFournitures = lignes.reduce((sum, l) => sum + (l.quantite * l.prix_unitaire), 0);
    const totalHT = totalFournitures + (main_oeuvre || 0);
    const numero = `DEV-${Date.now()}`;

    // ── Sauvegarder en base ────────────────────────────────────
    const devisId = uuidv4();
    await pool.query(
      `INSERT INTO devis (id, artisan_id, numero, client_nom, client_telephone, objet,
        type_travaux, lignes, surfaces, main_oeuvre, acompte, total, statut, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'envoye',NOW())`,
      [devisId, req.user.id, numero, client_nom, client_telephone || '', objet || '',
       type_travaux || '', JSON.stringify(lignes), JSON.stringify(surfaces || []),
       main_oeuvre || 0, acompte || 0, totalHT]
    );

    // ── Mettre à jour tarifs (autocomplétion) ─────────────────
    for (const l of lignes) {
      await pool.query(
        `INSERT INTO tarifs (id, artisan_id, designation, unite, prix_unitaire, usage_count)
         VALUES ($1,$2,$3,$4,$5,1)
         ON CONFLICT (artisan_id, designation)
         DO UPDATE SET prix_unitaire=$5, usage_count=tarifs.usage_count+1`,
        [uuidv4(), req.user.id, l.designation, l.unite || 'unité', l.prix_unitaire]
      );
    }

    // ── Incrémenter compteur devis ─────────────────────────────
    await pool.query('UPDATE artisans SET devis_count=devis_count+1 WHERE id=$1', [req.user.id]);

    // ── Générer PDF ────────────────────────────────────────────
    const outputDir = path.join(__dirname, 'outputs');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    const pdfPath = path.join(outputDir, `${devisId}.pdf`);

    await generatePDF({
      artisan, numero, client_nom, client_telephone, objet,
      type_travaux, lignes, surfaces, main_oeuvre, acompte, totalHT, pdfPath
    });

    // ── Mettre à jour chemin PDF ───────────────────────────────
    const pdfUrl = `/outputs/${devisId}.pdf`;
    await pool.query('UPDATE devis SET pdf_url=$1 WHERE id=$2', [pdfUrl, devisId]);

    res.status(201).json({
      id: devisId,
      numero,
      total: totalHT,
      pdf_url: pdfUrl,
      message: `Devis ${numero} créé avec succès`
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la création du devis' });
  }
});

// GET /api/devis — liste des devis
app.get('/api/devis', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, numero, client_nom, objet, total, statut, created_at
       FROM devis WHERE artisan_id=$1 ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/devis/:id — détail d'un devis
app.get('/api/devis/:id', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM devis WHERE id=$1 AND artisan_id=$2',
      [req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Devis introuvable' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ══════════════════════════════════════════════════════════════
// ROUTE BOT CONVERSATION (IA Mistral)
// ══════════════════════════════════════════════════════════════

// POST /api/bot/message
app.post('/api/bot/message', authMiddleware, async (req, res) => {
  const { message, history, devis_draft } = req.body;

  // Récupérer profil artisan
  const artisanResult = await pool.query(
    'SELECT nom, metier FROM artisans WHERE id=$1', [req.user.id]
  );
  const artisan = artisanResult.rows[0];

  const systemPrompt = `Tu es DevisPro, un assistant vocal pour artisans en Côte d'Ivoire.
Tu aides ${artisan.nom} (${artisan.metier}) à créer des devis professionnels.
Tu poses UNE question à la fois, de manière simple et directe.

WORKFLOW DE CRÉATION DE DEVIS :
1. Demande le nom du client
2. Demande le type de travaux
3. Si type = carrelage/peinture/faux plafond : propose le calcul de surface (longueur × largeur, pièce par pièce)
4. Pour chaque fourniture : désignation → quantité → unité → prix unitaire → confirme → "Autre fourniture ?"
5. Demande le coût de la main-d'œuvre
6. Demande si un acompte est souhaité
7. Résume le devis et demande confirmation

RÈGLES :
- Réponds TOUJOURS en français simple, comme on parle à Abidjan
- UNE question par réponse, jamais deux
- Si l'artisan dit "c'est tout" ou "non" après une fourniture, passe à la main-d'œuvre
- Quand le devis est complet, réponds avec JSON : {"action":"create_devis","data":{...}}
- Pour les surfaces, calcule automatiquement longueur × largeur et propose +10% pour chutes

ÉTAT ACTUEL DU DEVIS EN COURS :
${JSON.stringify(devis_draft || {}, null, 2)}`;

  const messages = [
    ...(history || []).map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: message }
  ];

  try {
    const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.MISTRAL_API_KEY}`
      },
      body: JSON.stringify({
        model: 'mistral-large-latest',
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        temperature: 0.3,
        max_tokens: 400
      })
    });

    const data = await response.json();
    const reply = data.choices[0].message.content;

    // Détecter si le bot a finalisé le devis
    let action = null;
    if (reply.includes('"action":"create_devis"')) {
      try {
        const jsonMatch = reply.match(/\{[\s\S]*\}/);
        if (jsonMatch) action = JSON.parse(jsonMatch[0]);
      } catch {}
    }

    res.json({ reply, action });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur IA' });
  }
});

// ══════════════════════════════════════════════════════════════
// GÉNÉRATEUR PDF
// ══════════════════════════════════════════════════════════════

function generatePDF({ artisan, numero, client_nom, client_telephone, objet,
  type_travaux, lignes, surfaces, main_oeuvre, acompte, totalHT, pdfPath }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const stream = fs.createWriteStream(pdfPath);
    doc.pipe(stream);

    const BLUE  = '#1A3A5C';
    const GOLD  = '#C9952B';
    const GRAY  = '#F5F5F5';
    const WHITE = '#FFFFFF';
    const DARK  = '#1C1C1C';
    const pageW = 595 - 100; // largeur utilisable

    // ── En-tête ──────────────────────────────────────────────
    doc.rect(0, 0, 595, 90).fill(BLUE);
    doc.fillColor(WHITE).fontSize(22).font('Helvetica-Bold')
       .text('DevisPro CI', 50, 20);
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
    doc.fillColor(BLUE).fontSize(9).font('Helvetica-Bold')
       .text('CLIENT', 60, 112);
    doc.fillColor(DARK).font('Helvetica').fontSize(11)
       .text(client_nom, 60, 126);
    if (client_telephone) {
      doc.fontSize(9).fillColor('#555555').text(`Tél : ${client_telephone}`, 60, 142);
    }
    if (objet) {
      doc.fillColor(GOLD).fontSize(9).font('Helvetica-Bold').text('OBJET', 320, 112);
      doc.fillColor(DARK).font('Helvetica').fontSize(10).text(objet, 320, 126, { width: 200 });
    }

    // ── Surfaces (si carrelage) ───────────────────────────────
    let y = 185;
    if (surfaces && surfaces.length > 0) {
      doc.fillColor(BLUE).fontSize(9).font('Helvetica-Bold').text('SURFACES', 50, y);
      y += 14;
      surfaces.forEach(s => {
        doc.fillColor(DARK).font('Helvetica').fontSize(9)
           .text(`${s.nom_piece} : ${s.longueur}m × ${s.largeur}m = ${s.surface} m²`, 60, y);
        y += 14;
      });
      y += 6;
    }

    // ── Tableau lignes ────────────────────────────────────────
    const colX   = [50, 230, 295, 360, 445];
    const colW   = [180, 65,  65,  85,  100];
    const headers = ['Désignation', 'Qté', 'Unité', 'P.U (FCFA)', 'Total (FCFA)'];

    doc.rect(50, y, pageW, 22).fill(BLUE);
    headers.forEach((h, i) => {
      doc.fillColor(WHITE).fontSize(9).font('Helvetica-Bold')
         .text(h, colX[i], y + 7, { width: colW[i], align: i > 0 ? 'center' : 'left' });
    });
    y += 22;

    lignes.forEach((l, idx) => {
      const total = l.quantite * l.prix_unitaire;
      const bg = idx % 2 === 0 ? WHITE : GRAY;
      doc.rect(50, y, pageW, 20).fill(bg);
      const cells = [
        l.designation,
        String(l.quantite),
        l.unite || 'u.',
        Number(l.prix_unitaire).toLocaleString('fr-FR'),
        Number(total).toLocaleString('fr-FR')
      ];
      cells.forEach((c, i) => {
        doc.fillColor(DARK).font('Helvetica').fontSize(9)
           .text(c, colX[i], y + 6, { width: colW[i], align: i > 0 ? 'center' : 'left' });
      });
      y += 20;
    });

    // Ligne main-d'œuvre
    if (main_oeuvre > 0) {
      doc.rect(50, y, pageW, 20).fill('#EEF4FA');
      doc.fillColor(BLUE).font('Helvetica-Bold').fontSize(9)
         .text("Main-d'œuvre", colX[0], y + 6, { width: colW[0] });
      doc.fillColor(DARK).font('Helvetica').fontSize(9)
         .text(Number(main_oeuvre).toLocaleString('fr-FR'), colX[4], y + 6, { width: colW[4], align: 'center' });
      y += 20;
    }

    // Séparateur
    y += 10;
    doc.moveTo(50, y).lineTo(545, y).strokeColor(GOLD).lineWidth(1).stroke();
    y += 10;

    // Totaux
    const totaux = [
      ['Sous-total fournitures', lignes.reduce((s, l) => s + l.quantite * l.prix_unitaire, 0)],
      ["Main-d'œuvre", main_oeuvre || 0],
      ['TOTAL TTC', totalHT],
    ];
    if (acompte > 0) totaux.push(['Acompte demandé', acompte]);

    totaux.forEach(([label, val], i) => {
      const isTotal = label === 'TOTAL TTC';
      if (isTotal) {
        doc.rect(360, y - 2, pageW - 310, 22).fill(BLUE);
      }
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
       .text('Ce devis est valable 30 jours à compter de sa date d\'émission.', 60, y + 22);

    doc.fillColor(GOLD).fontSize(7).font('Helvetica')
       .text('Généré par DevisPro CI', 50, 820, { align: 'center', width: pageW });

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

// ══════════════════════════════════════════════════════════════
// HEALTH CHECK
// ══════════════════════════════════════════════════════════════
app.get('/health', (req, res) => res.json({ status: 'ok', app: 'DevisPro CI', version: '1.0.0' }));

// ── Start ──────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`DevisPro CI backend running on port ${PORT}`));
