// ── bot.js — Logique conversation DevisPro CI ─────────────────

const Bot = {
  history:     [],
  devis_draft: {},
  step:        'idle',   // idle | creating | done
  progress:    0,

  reset() {
    this.history     = [];
    this.devis_draft = {};
    this.step        = 'idle';
    this.progress    = 0;
    setProgress(0);
  },

  async send(userMessage) {
    this.history.push({ role: 'user', content: userMessage });

    try {
      const res = await Api.botMessage(userMessage, this.history, this.devis_draft);
      const { reply, action } = res;

      this.history.push({ role: 'assistant', content: reply });

      // Mettre à jour le brouillon du devis si des données sont détectées
      this._updateDraft(userMessage, reply);

      // Avancer la barre de progression
      this._advanceProgress(reply);

      if (action && action.action === 'create_devis') {
        return { reply, finalAction: action.data };
      }

      return { reply, quickReplies: this._detectQuickReplies(reply) };
    } catch (err) {
      console.error('Bot error:', err);
      return { reply: "Désolé, une erreur s'est produite. Réessaie dans un moment.", quickReplies: [] };
    }
  },

  _updateDraft(userMsg, botReply) {
    // Détecter les étapes clés pour mettre à jour le brouillon visible
    if (botReply.toLowerCase().includes('nom du client')) this.step = 'client';
    if (botReply.toLowerCase().includes('type de travaux'))  this.step = 'type';
    if (botReply.toLowerCase().includes('désignation'))      this.step = 'fourniture';
    if (botReply.toLowerCase().includes('main-d\'œuvre'))    this.step = 'mo';
    if (botReply.toLowerCase().includes('acompte'))          this.step = 'acompte';
  },

  _advanceProgress(reply) {
    const steps = {
      'nom du client': 10,
      'type de travaux': 20,
      'longueur': 35,
      'surface': 45,
      'désignation': 50,
      'quantité': 60,
      'prix unitaire': 70,
      "main-d'œuvre": 80,
      'acompte': 88,
      'confirmes': 95,
      'créé': 100,
    };
    const lower = reply.toLowerCase();
    for (const [kw, pct] of Object.entries(steps)) {
      if (lower.includes(kw) && pct > this.progress) {
        this.progress = pct;
        setProgress(pct);
        break;
      }
    }
  },

  _detectQuickReplies(reply) {
    const lower = reply.toLowerCase();
    if (lower.includes('autre fourniture') || lower.includes('autre article')) {
      return ['Oui', 'Non, c\'est tout'];
    }
    if (lower.includes('surface') && lower.includes('calculer')) {
      return ['Oui', 'Non, je connais déjà'];
    }
    if (lower.includes('autre pièce')) {
      return ['Oui', 'Non'];
    }
    if (lower.includes('confirmes') || lower.includes('confirmer')) {
      return ['Oui, envoyer le devis', 'Non, corriger'];
    }
    if (lower.includes('+10%') || lower.includes('chutes')) {
      return ['Oui, +10%', 'Non, garder la surface exacte'];
    }
    if (lower.includes('acompte') && lower.includes('?')) {
      return ['Pas d\'acompte', '25%', '50%'];
    }
    return [];
  }
};
