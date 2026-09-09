// ── api.js v4.3 — Client HTTP DevisPro CI ─────────────────────
const API_BASE = window.DEVISPRO_API_BASE || 'https://blud911-devispro-backend.onrender.com';

const Api = {
  token: localStorage.getItem('dp_token'),

  setToken(t)  { this.token = t; localStorage.setItem('dp_token', t); },
  clearToken() { this.token = null; localStorage.removeItem('dp_token'); localStorage.removeItem('dp_artisan'); },

  async request(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    const res  = await fetch(`${API_BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // On garde le code HTTP sur l'erreur : certaines vues (ex. envoi email non
      // configuré → 503) doivent réagir différemment selon le statut.
      const err = new Error(data.error || 'Erreur réseau');
      err.status = res.status;
      err.data   = data;
      throw err;
    }
    return data;
  },

  async login(telephone, password) {
    const res  = await fetch(`${API_BASE}/api/auth/login`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ telephone, password })
    });
    const data = await res.json();
    if (res.status === 403) return data;
    if (!res.ok) throw new Error(data.error || 'Numéro ou mot de passe incorrect');
    return data;
  },

  register(nom, telephone, metier, password, email, nomEntreprise) { return this.request('POST', '/api/auth/register', { nom, telephone, metier, password, email, nom_entreprise: nomEntreprise }); },
  activateCode(code)                         { return this.request('POST', '/api/auth/activate',  { code }); },

  getProfil()        { return this.request('GET', '/api/profil'); },
  updateProfil(data) { return this.request('PUT', '/api/profil', data); },

  botMessage(message, history, devis_draft) { return this.request('POST', '/api/bot/message', { message, history, devis_draft }); },
  analyzePhoto(base64Image)                 { return this.request('POST', '/api/bot/photo',   { image: base64Image }); },

  createDevis(data) { return this.request('POST', '/api/devis',       data); },
  listDevis()       { return this.request('GET',  '/api/devis'); },
  getDevis(id)      { return this.request('GET',  `/api/devis/${id}`); },

  // Marque un devis comme payé → le backend le transforme en facture
  // (statut 'paye' + numero_facture). Idempotent côté serveur.
  marquerPaye(devisId) { return this.request('PUT', `/api/devis/${devisId}/marquer-paye`); },

  // [L1] Récupération du PDF privé par fetch + en-tête Authorization. Le token
  // ne transite PLUS en query string : il finissait dans les access logs
  // Render/Cloudflare, l'historique du navigateur, les favoris et le Referer.
  async getPdfBlob(devisId) {
    const headers = {};
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    const res = await fetch(`${API_BASE}/api/devis/${devisId}/pdf`, { headers });
    if (!res.ok) {
      const err = new Error('Impossible de charger le PDF');
      err.status = res.status;
      throw err;
    }
    return res.blob();
  },

  // ✅ v4.3 : génère un lien de partage public 7j pour WhatsApp
  shareDevis(devisId) { return this.request('POST', `/api/devis/${devisId}/share`); },

  // Envoi manuel du PDF du devis au client par email (Brevo, côté backend)
  envoyerDevisParEmail(devisId) { return this.request('POST', `/api/devis/${devisId}/envoyer-email`); },

  searchTarifs(q) { return this.request('GET', `/api/tarifs?q=${encodeURIComponent(q)}`); },
};
