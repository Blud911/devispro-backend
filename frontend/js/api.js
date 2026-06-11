// ── api.js — Client HTTP DevisPro CI ──────────────────────────
const API_BASE = window.DEVISPRO_API_BASE || 'https://blud911-devispro-backend.onrender.com';

const Api = {
  token: localStorage.getItem('dp_token'),

  setToken(t) {
    this.token = t;
    localStorage.setItem('dp_token', t);
  },

  clearToken() {
    this.token = null;
    localStorage.removeItem('dp_token');
    localStorage.removeItem('dp_artisan');
  },

  async request(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur réseau');
    return data;
  },

  // Auth
  login(telephone, password) {
    return this.request('POST', '/api/auth/login', { telephone, password });
  },
  register(nom, telephone, metier, password) {
    return this.request('POST', '/api/auth/register', { nom, telephone, metier, password });
  },

  // Profil
  getProfil()        { return this.request('GET', '/api/profil'); },
  updateProfil(data) { return this.request('PUT', '/api/profil', data); },

  // Bot
  botMessage(message, history, devis_draft) {
    return this.request('POST', '/api/bot/message', { message, history, devis_draft });
  },

  // Photo / Pixtral
  analyzePhoto(base64Image) {
    return this.request('POST', '/api/bot/photo', { image: base64Image });
  },

  // Devis
  createDevis(data) { return this.request('POST', '/api/devis', data); },
  listDevis()       { return this.request('GET',  '/api/devis'); },
  getDevis(id)      { return this.request('GET',  `/api/devis/${id}`); },

  // Tarifs
  searchTarifs(q)   { return this.request('GET', `/api/tarifs?q=${encodeURIComponent(q)}`); },
};
