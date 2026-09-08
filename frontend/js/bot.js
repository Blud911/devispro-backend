// ── bot.js v2 — Logique conversation DevisPro CI ──────────────
// Corrections : détection JSON robuste, contact client, limite gratuit

// ── VALIDATION DÉFENSIVE client_telephone (Piste 3) ───────────
// Cas réel observé : l'IA a rempli client_telephone avec "12500" — en fait le
// prix unitaire d'une fourniture du MÊME draft (hallucination d'une valeur
// PLAUSIBLE, pas un simple oubli). La fusion "vide → ancien" ne protège que
// contre le vide ; ces deux tests rejettent une valeur au format implausible
// OU qui collisionne avec une valeur numérique déjà présente dans le draft.
function telephonePlausible(val) {
  if (!val || typeof val !== 'string') return false;
  const chiffres = val.replace(/[^\d]/g, '');
  return chiffres.length >= 8 && chiffres.length <= 13;
}
function enCollisionAvecUneValeurNumerique(val, draft) {
  if (!val) return false;
  const cible = String(val).replace(/[^\d]/g, '');
  if (!cible) return false;
  const valeurs = [];
  if (draft.main_oeuvre != null) valeurs.push(String(draft.main_oeuvre));
  if (draft.acompte != null) valeurs.push(String(draft.acompte));
  (draft.lignes || []).forEach(l => {
    if (l.quantite != null) valeurs.push(String(l.quantite));
    if (l.prix_unitaire != null) valeurs.push(String(l.prix_unitaire));
  });
  return valeurs.includes(cible);
}

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
      const { reply, action, draft } = res;

      // ── Mémoire structurée du devis ──────────────────────────
      // À chaque tour (hors réponse finale), l'IA renvoie dans res.draft
      // l'état CUMULÉ complet du devis. En théorie on pourrait l'écraser tel
      // quel ; en pratique le LLM oublie parfois une donnée DÉJÀ connue au
      // milieu d'une conversation qui dévie du WORKFLOW du prompt (observé en
      // test réel sur un scénario mécanique où le bot a improvisé au-delà du
      // script : client_nom / client_telephone / type_travaux remis à null en
      // plein milieu, bloc <<<DRAFT>>> pourtant syntaxiquement valide → la
      // création du devis échouait côté backend avec "Données incomplètes").
      //
      // Filet de sécurité qui NE dépend PAS de la fiabilité du LLM à suivre
      // l'instruction textuelle du prompt : pour les 4 champs SCALAIRES qui,
      // une fois connus, ne redeviennent jamais vides normalement, on refuse
      // un retour à vide/null/falsy si l'ancien devis_draft avait déjà une
      // valeur non vide — on conserve alors l'ANCIENNE. Les champs qui
      // évoluent légitimement au fil de la conversation (lignes, main_oeuvre,
      // acompte) gardent l'écrasement complet : si l'artisan corrige, on suit
      // le nouveau draft même quand la valeur "revient en arrière".
      if (draft && typeof draft === 'object' && !Array.isArray(draft)) {
        const CHAMPS_PROTEGES = ['client_nom', 'client_telephone', 'client_email', 'type_travaux'];
        const ancien   = this.devis_draft || {};
        const fusionne = { ...draft };

        // Validation défensive : si l'IA a mis une valeur implausible OU
        // collisionnant avec un montant du draft dans client_telephone
        // (ex. "12500" = prix d'une fourniture), on la neutralise AVANT la
        // fusion → elle est alors traitée comme un oubli normal, et la boucle
        // ci-dessous restaure l'ancienne valeur connue si elle existe.
        if (fusionne.client_telephone &&
            (!telephonePlausible(fusionne.client_telephone) ||
             enCollisionAvecUneValeurNumerique(fusionne.client_telephone, draft))) {
          fusionne.client_telephone = null;
        }

        for (const champ of CHAMPS_PROTEGES) {
          if (!fusionne[champ] && ancien[champ]) fusionne[champ] = ancien[champ];
        }
        this.devis_draft = fusionne;
      }

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
    if (lower.includes('email du client') || lower.includes("l'email du client")) {
      return ["Pas d'email"];
    }
    return [];
  }
};
