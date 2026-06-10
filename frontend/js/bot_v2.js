// ── bot.js v2 — Logique conversation DevisPro CI ──────────────
// Corrections : détection JSON robuste, contact client, limite gratuit

const Bot = {
  history:     [],
  devis_draft: {},
  step:        'idle',
  progress:    0,
  pendingPhoto: null,

  reset() {
    this.history     = [];
    this.devis_draft = {};
    this.step        = 'idle';
    this.progress    = 0;
    this.pendingPhoto = null;
    setProgress(0);
  },

  async send(userMessage) {
    this.history.push({ role: 'user', content: userMessage });

    try {
      const res = await Api.botMessage(userMessage, this.history, this.devis_draft);
      const { reply, action } = res;

      this.history.push({ role: 'assistant', content: reply });
      this._updateDraft(userMessage, reply);
      this._advanceProgress(reply);

      // ── Détection JSON robuste ─────────────────────────────
      // 1. Action déjà parsée par le backend
      if (action && action.action === 'create_devis') {
        return { reply: '✅ Devis finalisé !', finalAction: action.data };
      }

      // 2. Le reply lui-même contient le JSON (Mistral l'a mis dans le texte)
      if (reply.includes('create_devis') || reply.includes('"action"')) {
        try {
          // Extraire le JSON même s'il y a du texte autour
          const jsonMatch = reply.match(/\{[\s\S]*"action"[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            if (parsed.action === 'create_devis' && parsed.data) {
              return { reply: '✅ Devis finalisé !', finalAction: parsed.data };
            }
          }
        } catch(e) {
          // Parsing échoué → continuer normalement
        }
      }

      return { reply, quickReplies: this._detectQuickReplies(reply) };

    } catch (err) {
      console.error('Bot error:', err);
      return {
        reply: "Désolé, une erreur s'est produite. Réessaie dans un moment.",
        quickReplies: []
      };
    }
  },

  _updateDraft(userMsg, botReply) {
    const lower = botReply.toLowerCase();
    if (lower.includes('nom du client'))   this.step = 'client';
    if (lower.includes('contact') || lower.includes('téléphone du client')) this.step = 'contact';
    if (lower.includes('type de travaux')) this.step = 'type';
    if (lower.includes('désignation'))     this.step = 'fourniture';
    if (lower.includes("main-d'œuvre"))    this.step = 'mo';
    if (lower.includes('acompte'))         this.step = 'acompte';
  },

  _advanceProgress(reply) {
    const steps = {
      'nom du client':   10,
      'contact':         18,
      'type de travaux': 25,
      'longueur':        35,
      'surface':         45,
      'désignation':     52,
      'quantité':        62,
      'prix unitaire':   72,
      "main-d'œuvre":    82,
      'acompte':         90,
      'confirmes':       96,
      'créé':           100,
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
      return ['Oui', "Non, c'est tout"];
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
      return ["Pas d'acompte", '25%', '50%'];
    }
    if (lower.includes('contact') || lower.includes('téléphone du client')) {
      return ['Pas de numéro'];
    }
    return [];
  }
};
