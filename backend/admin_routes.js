// ══════════════════════════════════════════════════════════════
// ROUTES ADMIN — à ajouter dans server.js (avant app.listen)
// ══════════════════════════════════════════════════════════════

// ── Middleware admin JWT ───────────────────────────────────────
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

// POST /api/admin/login
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'devispro_admin_2026';
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Mot de passe incorrect' });
  }
  const token = jwt.sign({ admin: true }, process.env.JWT_SECRET, { expiresIn: '8h' });
  res.json({ token });
});

// GET /api/admin/stats
app.get('/api/admin/stats', adminAuth, async (req, res) => {
  try {
    const [artisans, devis, ca, plans] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM artisans'),
      pool.query('SELECT COUNT(*) FROM devis'),
      pool.query('SELECT COALESCE(SUM(total),0) AS total FROM devis'),
      pool.query(`SELECT plan, COUNT(*) as count FROM artisans GROUP BY plan ORDER BY count DESC`)
    ]);
    const devis7j = await pool.query(
      `SELECT COUNT(*) FROM devis WHERE created_at >= NOW() - INTERVAL '7 days'`
    );
    const artisans7j = await pool.query(
      `SELECT COUNT(*) FROM artisans WHERE created_at >= NOW() - INTERVAL '7 days'`
    );
    res.json({
      total_artisans:  parseInt(artisans.rows[0].count),
      total_devis:     parseInt(devis.rows[0].count),
      chiffre_affaires: parseInt(ca.rows[0].total),
      devis_7j:        parseInt(devis7j.rows[0].count),
      artisans_7j:     parseInt(artisans7j.rows[0].count),
      plans:           plans.rows
    });
  } catch (err) {
    console.error('[ADMIN] stats error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/admin/artisans?page=1&search=
app.get('/api/admin/artisans', adminAuth, async (req, res) => {
  const page   = parseInt(req.query.page) || 1;
  const limit  = 20;
  const offset = (page - 1) * limit;
  const search = req.query.search ? `%${req.query.search}%` : '%';
  try {
    const [rows, total] = await Promise.all([
      pool.query(
        `SELECT id, nom, prenom, telephone, metier, plan, devis_count, created_at
         FROM artisans
         WHERE nom ILIKE $1 OR telephone ILIKE $1 OR metier ILIKE $1
         ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [search, limit, offset]
      ),
      pool.query(
        `SELECT COUNT(*) FROM artisans WHERE nom ILIKE $1 OR telephone ILIKE $1 OR metier ILIKE $1`,
        [search]
      )
    ]);
    res.json({ artisans: rows.rows, total: parseInt(total.rows[0].count), page, limit });
  } catch (err) {
    console.error('[ADMIN] artisans error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/admin/artisans/:id/plan
app.put('/api/admin/artisans/:id/plan', adminAuth, async (req, res) => {
  const { plan } = req.body;
  const plans_valides = ['gratuit', 'starter', 'pro'];
  if (!plans_valides.includes(plan)) {
    return res.status(400).json({ error: 'Plan invalide' });
  }
  try {
    await pool.query('UPDATE artisans SET plan=$1 WHERE id=$2', [plan, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE /api/admin/artisans/:id
app.delete('/api/admin/artisans/:id', adminAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM artisans WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/admin/devis?page=1&search=
app.get('/api/admin/devis', adminAuth, async (req, res) => {
  const page   = parseInt(req.query.page) || 1;
  const limit  = 20;
  const offset = (page - 1) * limit;
  const search = req.query.search ? `%${req.query.search}%` : '%';
  try {
    const [rows, total] = await Promise.all([
      pool.query(
        `SELECT d.id, d.numero, d.client_nom, d.objet, d.total, d.statut, d.created_at,
                a.nom as artisan_nom, a.telephone as artisan_tel
         FROM devis d
         JOIN artisans a ON d.artisan_id = a.id
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
  } catch (err) {
    console.error('[ADMIN] devis error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/admin/logs — dernières erreurs console (simulées via table)
app.get('/api/admin/logs', adminAuth, async (req, res) => {
  try {
    // Stats de santé système
    const [pool_stats, recent_errors] = await Promise.all([
      pool.query('SELECT COUNT(*) as connections FROM artisans'),
      pool.query(
        `SELECT 'Devis sans PDF' as type, COUNT(*) as count, MAX(created_at) as last_seen
         FROM devis WHERE pdf_url IS NULL AND created_at > NOW() - INTERVAL '24h'
         UNION ALL
         SELECT 'Artisans inactifs (0 devis)' as type, COUNT(*) as count, MAX(created_at) as last_seen
         FROM artisans WHERE devis_count = 0 AND created_at < NOW() - INTERVAL '7 days'`
      )
    ]);
    res.json({
      status: 'ok',
      db_connected: true,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      alerts: recent_errors.rows
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur', db_connected: false });
  }
});

// ══════════════════════════════════════════════════════════════
// FIN DES ROUTES ADMIN
// ══════════════════════════════════════════════════════════════
