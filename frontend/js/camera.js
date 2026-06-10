// ── camera.js — Gestion photo + Pixtral pour DevisPro CI ──────
// À ajouter dans frontend/js/camera.js
// Chargé dans app.html après api.js

const Camera = {

  // ── Ouvrir la caméra via input file ───────────────────────
  open() {
    // Créer un input file caché si pas encore existant
    let input = document.getElementById('camera-input');
    if (!input) {
      input = document.createElement('input');
      input.type    = 'file';
      input.accept  = 'image/*';
      input.capture = 'environment'; // caméra arrière
      input.id      = 'camera-input';
      input.style.display = 'none';
      document.body.appendChild(input);
      input.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) Camera.handleFile(file);
        input.value = ''; // reset pour permettre re-sélection
      });
    }
    input.click();
  },

  // ── Traitement du fichier image ────────────────────────────
  async handleFile(file) {
    // Vérification taille (max 4 Mo)
    if (file.size > 4 * 1024 * 1024) {
      appendMessage('bot', '📷 Image trop lourde (max 4 Mo). Prends une photo en résolution standard.');
      return;
    }

    // Afficher préview dans le chat
    const previewUrl = URL.createObjectURL(file);
    Camera.showPreview(previewUrl, file.name);

    // Convertir en base64
    const base64 = await Camera.toBase64(file);

    // Afficher indicateur d'analyse
    showTyping();
    appendMessage('bot', '📷 Photo reçue — analyse en cours avec Pixtral...');

    try {
      const result = await Api.analyzePhoto(base64);
      hideTyping();
      Camera.handleResult(result);
    } catch (err) {
      hideTyping();
      appendMessage('bot', `❌ Erreur lors de l'analyse : ${err.message}`);
    }
  },

  // ── Afficher préview de la photo ───────────────────────────
  showPreview(url, name) {
    const chat = document.getElementById('chat');
    const div  = document.createElement('div');
    div.className = 'msg user';
    div.innerHTML = `
      <div class="msg-avatar">👷</div>
      <div class="msg-bubble" style="padding:6px;">
        <img src="${url}" alt="${name}"
          style="max-width:200px;max-height:150px;border-radius:8px;display:block;cursor:pointer;"
          onclick="window.open('${url}','_blank')">
        <div style="font-size:11px;color:rgba(255,255,255,0.6);margin-top:4px;">📷 ${name}</div>
      </div>`;
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
  },

  // ── Interpréter le résultat Pixtral ───────────────────────
  handleResult(result) {
    if (result.type === 'piece') {
      Camera.handlePiece(result);
    } else if (result.type === 'document') {
      Camera.handleDocument(result);
    } else {
      appendMessage('bot', `🤖 ${result.message || 'Image non reconnue. Essaie avec une photo de pièce ou d\'un bon de commande.'}`);
    }
  },

  // ── Résultat : pièce détectée ──────────────────────────────
  handlePiece(data) {
    const { piece_detectee, dimensions_estimees, surface_estimee, confiance, notes, type_travaux_suggere } = data;
    const dim = dimensions_estimees;
    const confLabel = { haute: '✅ haute', moyenne: '⚠️ moyenne', faible: '❗ faible' }[confiance] || confiance;

    const msg = `📐 J'ai analysé la photo :\n\n` +
      `Pièce : **${piece_detectee}**\n` +
      `Dimensions estimées : ~${dim.longueur}m × ${dim.largeur}m\n` +
      `Surface : ~${surface_estimee} m²\n` +
      `Confiance : ${confLabel}\n` +
      (notes ? `Notes : ${notes}\n` : '') +
      `\nType de travaux suggéré : ${type_travaux_suggere || '—'}\n\n` +
      `Tu veux utiliser ces dimensions pour le devis ?`;

    appendMessage('bot', msg);

    // Quick replies avec les valeurs pré-remplies
    setQuickReplies([
      `Oui, ${surface_estimee} m²`,
      `Oui mais modifier`,
      `Non, saisir manuellement`
    ]);

    // Stocker dans Bot pour usage si confirmation
    Bot.pendingPhoto = {
      type: 'piece',
      piece: piece_detectee,
      longueur: dim.longueur,
      largeur: dim.largeur,
      surface: surface_estimee,
      type_travaux: type_travaux_suggere
    };
  },

  // ── Résultat : document détecté ───────────────────────────
  handleDocument(data) {
    const { lignes, fournisseur, total_document, notes } = data;

    if (!lignes || !lignes.length) {
      appendMessage('bot', '📄 Document détecté mais aucune ligne de prix lisible. Essaie avec une photo plus nette.');
      return;
    }

    // Afficher les lignes extraites
    let msg = `📄 J'ai lu ${lignes.length} ligne${lignes.length > 1 ? 's' : ''} dans le document`;
    if (fournisseur) msg += ` (${fournisseur})`;
    msg += ' :\n\n';

    lignes.forEach((l, i) => {
      const total = l.quantite * l.prix_unitaire;
      msg += `${i + 1}. ${l.designation} — ${l.quantite} ${l.unite} × ${Number(l.prix_unitaire).toLocaleString('fr-FR')} FCFA = **${Number(total).toLocaleString('fr-FR')} FCFA**\n`;
    });

    if (total_document) msg += `\nTotal document : ${Number(total_document).toLocaleString('fr-FR')} FCFA`;
    if (notes) msg += `\n📝 ${notes}`;
    msg += '\n\nImporter ces lignes dans le devis ?';

    appendMessage('bot', msg);
    setQuickReplies(['Oui, importer tout', 'Oui mais vérifier', 'Non, ignorer']);

    // Stocker pour usage si confirmation
    Bot.pendingPhoto = { type: 'document', lignes, total: total_document };
  },

  // ── Convertir File en base64 ───────────────────────────────
  toBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }
};
