// ── app.js v4.3 — fix markdown, bouton WhatsApp lien partage ──

// ── PWA ───────────────────────────────────────────────────────
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault(); deferredInstallPrompt = e;
  document.getElementById('install-banner').classList.add('show');
});
function installPWA()    { if (!deferredInstallPrompt) return; deferredInstallPrompt.prompt(); deferredInstallPrompt.userChoice.then(() => dismissInstall()); }
function dismissInstall(){ document.getElementById('install-banner').classList.remove('show'); }
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(console.error);

// ── STATE ──────────────────────────────────────────────────────
let authMode   = 'login';
let currentTab = 'chat';

// ── MARKDOWN → TEXTE BRUT ─────────────────────────────────────
// ✅ v4.3 : nettoie le markdown que Mistral envoie parfois
function stripMarkdown(text) {
  return text
    .replace(/#{1,6}\s*/g, '')          // ### titres
    .replace(/\*\*(.+?)\*\*/g, '$1')   // **gras**
    .replace(/\*(.+?)\*/g, '$1')       // *italique*
    .replace(/^[-•]\s+/gm, '• ')       // tirets → bullet propre
    .replace(/^\d+\.\s+/gm, '')        // listes numérotées
    .trim();
}

// ── AUTH ───────────────────────────────────────────────────────
function toggleAuthMode() {
  authMode = authMode === 'login' ? 'register' : 'login';
  const rf   = document.getElementById('register-fields');
  const btn  = document.getElementById('auth-submit-btn');
  const link = document.getElementById('auth-toggle-link');
  rf.style.display = authMode === 'register' ? 'flex' : 'none';
  btn.textContent  = authMode === 'register' ? 'Créer mon compte' : 'Se connecter';
  link.innerHTML   = authMode === 'register'
    ? 'Déjà inscrit ? <span onclick="toggleAuthMode()">Se connecter</span>'
    : 'Pas encore inscrit ? <span onclick="toggleAuthMode()">Créer un compte</span>';
}

async function submitAuth() {
  const tel  = document.getElementById('auth-tel').value.trim();
  const pass = document.getElementById('auth-pass').value;
  const btn  = document.getElementById('auth-submit-btn');
  if (!tel || !pass) return alert('Remplis tous les champs');
  btn.textContent = '...'; btn.disabled = true;
  try {
    if (authMode === 'login') {
      const res = await Api.login(tel, pass);
      if (res.statut === 'en_attente') { if (res.token) Api.setToken(res.token); showPendingScreen(); return; }
      if (res.statut === 'suspendu' || res.statut === 'expiré') { alert("Abonnement expiré ou compte suspendu. Contactez l'administrateur."); return; }
      Api.setToken(res.token);
      localStorage.setItem('dp_artisan', JSON.stringify(res.artisan));
      showApp(res.artisan);
    } else {
      const nom        = document.getElementById('auth-nom').value.trim();
      const metier     = document.getElementById('auth-metier').value.trim();
      const entreprise = document.getElementById('auth-entreprise').value.trim();
      const email      = document.getElementById('auth-email').value.trim();
      if (!nom || !metier) { alert('Remplis ton nom et ton métier'); return; }
      const res = await Api.register(nom, tel, metier, pass, email, entreprise);
      if (res.token) Api.setToken(res.token);
      showPendingScreen();
    }
  } catch (err) {
    alert(err.message || 'Erreur de connexion');
  } finally {
    btn.disabled    = false;
    btn.textContent = authMode === 'login' ? 'Se connecter' : 'Créer mon compte';
  }
}

// ── ÉCRANS ─────────────────────────────────────────────────────
function showPendingScreen() {
  document.getElementById('auth-screen').style.display       = 'none';
  document.getElementById('activation-screen').style.display = 'flex';
}
function backToLogin() {
  document.getElementById('activation-screen').style.display = 'none';
  document.getElementById('auth-screen').style.display       = 'flex';
}

// ── ACTIVATION CODE ────────────────────────────────────────────
async function submitActivationCode() {
  const code = document.getElementById('activation-code-input').value.trim().toUpperCase();
  const btn  = document.getElementById('activation-btn');
  const err  = document.getElementById('activation-error');
  err.style.display = 'none';
  if (!code)       { err.textContent = "Entre ton code d'activation"; err.style.display = 'block'; return; }
  if (!Api.token)  { err.textContent = 'Session expirée. Reconnecte-toi.'; err.style.display = 'block'; return; }
  btn.textContent = '...'; btn.disabled = true;
  try {
    const res = await Api.activateCode(code);
    Api.setToken(res.token);
    localStorage.setItem('dp_artisan', JSON.stringify(res.artisan));
    document.getElementById('activation-screen').style.display = 'none';
    showApp(res.artisan);
  } catch (err2) {
    err.textContent = err2.message || 'Code invalide'; err.style.display = 'block';
  } finally {
    btn.disabled = false; btn.textContent = 'Activer mon compte';
  }
}

function showApp(artisan) {
  document.getElementById('auth-screen').style.display       = 'none';
  document.getElementById('activation-screen').style.display = 'none';
  document.getElementById('app').style.display               = 'flex';
  document.getElementById('header-sub').textContent = `Bonjour, ${artisan.nom} 👋`;
  if (artisan.plan === 'gratuit') showQuotaBanner(Math.max(0, 3 - (artisan.devis_count || 0)));

  // Analyse photo réservée aux métiers bâtiment/surface : le backend renvoie
  // photo_disponible === false pour les autres (mécanique auto, électroménager…).
  // On masque le bouton 📷 dans ce cas, on l'affiche normalement sinon.
  const cameraBtn = document.getElementById('camera-btn');
  if (cameraBtn) cameraBtn.style.display = artisan.photo_disponible === false ? 'none' : '';

  startBotGreeting(artisan);
}

window.addEventListener('DOMContentLoaded', () => {
  const stored = localStorage.getItem('dp_artisan');
  if (Api.token && stored) showApp(JSON.parse(stored));
});

// ── QUOTA BANNER ───────────────────────────────────────────────
function showQuotaBanner(restants) {
  const banner = document.getElementById('quota-banner');
  if (!banner) return;
  if (restants === 0) {
    banner.innerHTML        = `🔒 Vos 3 devis gratuits sont utilisés. <a href="#" onclick="showUpgradeMessage()" style="color:var(--gold);font-weight:700;">S'abonner →</a>`;
    banner.style.background = '#FED7D7'; banner.style.color = '#C53030';
  } else {
    banner.innerHTML        = `⚡ Plan gratuit : ${restants} devis restant${restants > 1 ? 's' : ''}`;
    banner.style.background = restants === 1 ? '#FEFCBF' : '#EBF8FF';
    banner.style.color      = restants === 1 ? '#744210' : '#2B6CB0';
  }
  banner.style.display = 'block';
}

function showUpgradeMessage() {
  appendMessage('bot', `Pour continuer, abonne-toi au plan Starter à 1 000 FCFA/mois.\n\nEnvoie le paiement via Wave CI ou Orange Money au ${window.DEVISPRO_PAYMENT_NUMBER}, puis clique ci-dessous pour prévenir l'administrateur.`);
  setQuickReplies(['Contacter via WhatsApp']);
}

// ── CONTACT ADMIN WHATSAPP ────────────────────────────────────
// Mécanique partagée : bouton quota (plan gratuit épuisé) ET bouton
// "Renouveler mon abonnement" (plans payants) ouvrent le même wa.me vers le
// numéro admin (window.DEVISPRO_ADMIN_WHATSAPP, défini dans config.js) avec un
// message pré-rempli. Avant, le bouton quota pointait vers un placeholder
// littéral `wa.me/[TON_NUMERO]?text=STARTER` — lien mort.
function contacterAdminWhatsApp(message) {
  const texte = encodeURIComponent(message);
  window.open(`https://wa.me/${window.DEVISPRO_ADMIN_WHATSAPP}?text=${texte}`, '_blank');
}

// ── CHAT UI ────────────────────────────────────────────────────
function appendMessage(role, text, extra) {
  const chat    = document.getElementById('chat');
  const div     = document.createElement('div');
  div.className = `msg ${role}`;
  const avatar  = document.createElement('div');
  avatar.className   = 'msg-avatar';
  avatar.textContent = role === 'bot' ? '🤖' : '👷';
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';

  if (extra && extra.type === 'devis-card') {
    // Bouton "Envoyer par mail" affiché UNIQUEMENT si le devis a un email client.
    const email       = (extra.email || '').trim();
    const hasEmail    = email.includes('@');
    const emailRow    = hasEmail
      ? `<div class="devis-card-actions">
          <button class="card-btn secondary" style="flex:1"
                  onclick="envoyerParMail('${extra.devis_id}', '${email}', this)">📧 Envoyer par mail</button>
        </div>`
      : '';
    bubble.innerHTML = `
      <div class="devis-card">
        <div class="devis-card-title">Devis généré</div>
        <div class="devis-card-total">${Number(extra.total).toLocaleString('fr-FR')} FCFA</div>
        <div class="devis-card-sub">${extra.client} · ${extra.numero}</div>
        <div class="devis-card-actions">
          <button class="card-btn primary"   onclick="voirPDF('${extra.devis_id}')">📄 Voir PDF</button>
          <button class="card-btn secondary" onclick="partagerWhatsApp('${extra.devis_id}', '${extra.phone}', '${extra.total}', '${extra.client}')">💬 WhatsApp</button>
        </div>
        ${emailRow}
      </div>`;
  } else {
    // ✅ v4.3 : texte nettoyé du markdown
    bubble.textContent = stripMarkdown(text || '');
  }

  div.appendChild(avatar);
  div.appendChild(bubble);
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  return bubble;
}

function showTyping() {
  const chat = document.getElementById('chat');
  const div  = document.createElement('div');
  div.className = 'msg bot'; div.id = 'typing-indicator';
  div.innerHTML = `<div class="msg-avatar">🤖</div><div class="msg-bubble"><div class="typing"><span></span><span></span><span></span></div></div>`;
  chat.appendChild(div); chat.scrollTop = chat.scrollHeight;
}
function hideTyping() { const t = document.getElementById('typing-indicator'); if (t) t.remove(); }

function setQuickReplies(options) {
  const qr = document.getElementById('quick-replies');
  qr.innerHTML = '';
  options.forEach(opt => {
    const btn = document.createElement('button');
    btn.className = 'qr-btn'; btn.textContent = opt;
    btn.onclick = () => {
      if (opt === 'Contacter via WhatsApp') {
        const stored = localStorage.getItem('dp_artisan');
        const a      = stored ? JSON.parse(stored) : null;
        const message = a
          ? `Bonjour, je souhaite m'abonner au plan Starter sur DevisPro CI. Nom : ${a.nom}, Téléphone : ${a.telephone}.`
          : "Bonjour, je souhaite m'abonner au plan Starter sur DevisPro CI.";
        contacterAdminWhatsApp(message);
        return;
      }
      setInput(opt); sendMessage();
    };
    qr.appendChild(btn);
  });
}

function setProgress(pct) { document.getElementById('progress-fill').style.width = `${pct}%`; }
function setInput(text)   { const inp = document.getElementById('msg-input'); inp.value = text; autoResize(inp); }
function autoResize(el)   { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 100) + 'px'; }
function handleKey(e)     { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }

// ── PDF & PARTAGE ──────────────────────────────────────────────
function voirPDF(devisId) {
  window.open(Api.getPdfUrl(devisId), '_blank');
}

// ✅ v4.3 : génère un lien public signé 7j puis ouvre WhatsApp
async function partagerWhatsApp(devisId, phone, total, clientNom) {
  try {
    const res  = await Api.shareDevis(devisId);
    const texte = encodeURIComponent(
      `Bonjour ${clientNom},\n\nVeuillez trouver votre devis — Montant : ${Number(total).toLocaleString('fr-FR')} FCFA.\n\n📄 Voir le devis : ${res.share_url}\n\n(Lien valable 7 jours)\n\nCordialement,\nDevisPro CI`
    );
    const numero = phone ? phone.replace(/\D/g, '') : '';
    window.open(`https://wa.me/${numero}?text=${texte}`, '_blank');
  } catch (err) {
    alert("Impossible de générer le lien de partage. Réessaie.");
  }
}

// ── ENVOI DU DEVIS PAR EMAIL (Brevo, côté backend) ────────────
async function envoyerParMail(devisId, email, btn) {
  const label = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Envoi en cours...'; }
  try {
    await Api.envoyerDevisParEmail(devisId);
    if (btn) btn.textContent = '✅ Envoyé';
    appendMessage('bot', `Devis envoyé à ${email}`);
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = label || '📧 Envoyer par mail'; }
    if (err.status === 503) {
      appendMessage('bot', "L'envoi par email n'est pas encore activé sur ton compte. Utilise le partage WhatsApp en attendant, ou contacte l'administrateur.");
    } else if (err.status === 400) {
      appendMessage('bot', "Ce devis n'a pas d'adresse email client : impossible de l'envoyer par mail.");
    } else {
      appendMessage('bot', `L'envoi de l'email a échoué : ${err.message}`);
    }
  }
}

// ── RECONNAISSANCE VOCALE ──────────────────────────────────────
let recognition = null, isListening = false, pendingTranscript = null;

function initSpeech() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const r = new SR(); r.lang = 'fr-FR'; r.continuous = false; r.interimResults = true;
  r.onstart  = () => { isListening = true; setMicState('listening'); };
  r.onresult = (e) => {
    let interim = '', final = '';
    for (const res of e.results) { if (res.isFinal) final += res[0].transcript; else interim += res[0].transcript; }
    const inp = document.getElementById('msg-input'); inp.value = final || interim; autoResize(inp);
  };
  r.onend   = () => { isListening = false; setMicState('idle'); const t = document.getElementById('msg-input').value.trim(); if (t) showVoiceConfirm(t); };
  r.onerror = (e) => { isListening = false; setMicState('idle'); if (e.error !== 'no-speech') appendMessage('bot', 'Micro non accessible.'); };
  return r;
}
function toggleMic() {
  if (!recognition) recognition = initSpeech();
  if (!recognition) { alert('Utilise Chrome pour la reconnaissance vocale.'); return; }
  if (isListening) { recognition.stop(); }
  else { hideVoiceConfirm(); document.getElementById('msg-input').value = ''; recognition.start(); }
}
function setMicState(state)       { const btn = document.getElementById('mic-btn'); if (!btn) return; btn.classList.toggle('listening', state === 'listening'); }
function showVoiceConfirm(text)   { pendingTranscript = text; document.getElementById('voice-confirm-text').textContent = `"${text}"`; document.getElementById('voice-confirm').style.display = 'flex'; }
function hideVoiceConfirm()       { document.getElementById('voice-confirm').style.display = 'none'; pendingTranscript = null; }
function confirmVoice(confirmed)  { hideVoiceConfirm(); if (confirmed && pendingTranscript) { sendMessage(); } else { document.getElementById('msg-input').value = ''; toggleMic(); } }

// ── BOT ────────────────────────────────────────────────────────
async function startBotGreeting(artisan) {
  Bot.reset();
  setTimeout(() => {
    appendMessage('bot', `Bonjour ${artisan.nom} ! Je suis prêt à t'aider à créer un devis professionnel. Appuie sur "Nouveau devis" ou dis-moi directement : quel client aujourd'hui ?`);
    setQuickReplies(['Nouveau devis']);
  }, 600);
}

function newDevis() {
  const stored = localStorage.getItem('dp_artisan');
  if (stored) {
    const a = JSON.parse(stored);
    if (a.plan === 'gratuit' && a.devis_count >= 3) {
      appendMessage('bot', "Vous avez utilisé vos 3 devis gratuits. Abonnez-vous pour continuer.");
      setQuickReplies(['Contacter via WhatsApp']); return;
    }
  }
  Bot.reset();
  document.getElementById('chat').innerHTML = '';
  setQuickReplies([]); hideVoiceConfirm(); showTyping();
  setTimeout(() => {
    hideTyping();
    appendMessage('bot', "C'est parti ! Quel est le nom de ton client ?");
    document.getElementById('msg-input').focus();
  }, 500);
}

async function sendMessage() {
  const inp  = document.getElementById('msg-input');
  const text = inp.value.trim(); if (!text) return;
  inp.value  = ''; autoResize(inp); setQuickReplies([]); hideVoiceConfirm();
  document.getElementById('send-btn').disabled = true;
  appendMessage('user', text); showTyping();
  try {
    const { reply, quickReplies, finalAction } = await Bot.send(text);
    hideTyping();
    if (reply && reply.includes('devis gratuits')) {
      appendMessage('bot', reply); setQuickReplies(['Contacter via WhatsApp']); return;
    }
    if (finalAction) {
      // Piste 2 : on n'insère plus directement. L'artisan voit d'abord un
      // écran de confirmation/édition (4 champs scalaires + récap fournitures/
      // totaux) et valide — filet indépendant de la fiabilité du modèle.
      appendMessage('bot', reply);
      showConfirmationDevis(finalAction);
    } else {
      appendMessage('bot', reply);
      if (quickReplies && quickReplies.length) setQuickReplies(quickReplies);
    }
  } catch { hideTyping(); appendMessage('bot', "Une erreur s'est produite. Réessaie."); }
  finally  { document.getElementById('send-btn').disabled = false; }
}

// ── CONFIRMATION / ÉDITION DU DEVIS AVANT INSERTION (Piste 2) ─
// Le backend assemble désormais l'action create_devis depuis SON état
// (devis_draft) au lieu de laisser l'IA la reproduire. On n'insère toujours
// pas directement : l'artisan relit/corrige les 4 champs scalaires + voit le
// récap fournitures/totaux (lecture seule), puis confirme. Ce filet est
// indépendant du modèle : quelle que soit la dérive de l'IA, rien de faux ne
// part en base sans relecture.
let pendingFinalAction = null;

function showConfirmationDevis(finalAction) {
  pendingFinalAction = finalAction;

  document.getElementById('confirm-nom').value       = finalAction.client_nom       || '';
  document.getElementById('confirm-tel').value       = finalAction.client_telephone || '';
  document.getElementById('confirm-email').value     = finalAction.client_email     || '';
  document.getElementById('confirm-type').value      = finalAction.type_travaux     || '';
  document.getElementById('confirm-reference').value = finalAction.reference_bien   || '';

  const fmt       = n => Number(n || 0).toLocaleString('fr-FR');
  const lignes    = Array.isArray(finalAction.lignes) ? finalAction.lignes : [];
  let   total     = 0;
  const lignesTxt = lignes.map(l => {
    const st = Number(l.quantite || 0) * Number(l.prix_unitaire || 0);
    total += st;
    return `• ${l.designation || '—'} : ${fmt(l.quantite)} × ${fmt(l.prix_unitaire)} = ${fmt(st)} FCFA`;
  }).join('\n');
  const mo      = Number(finalAction.main_oeuvre || 0);
  const acompte = Number(finalAction.acompte || 0);
  total += mo;

  document.getElementById('confirm-recap').textContent =
    `${lignesTxt || 'Aucune fourniture'}\n` +
    `Main-d'œuvre : ${fmt(mo)} FCFA\n` +
    (acompte > 0 ? `Acompte : ${fmt(acompte)} FCFA\n` : '') +
    `TOTAL : ${fmt(total)} FCFA`;

  document.getElementById('confirm-devis').style.display = 'block';
  const iz = document.getElementById('input-zone');    if (iz) iz.style.display = 'none';
  const qr = document.getElementById('quick-replies'); if (qr) qr.style.display = 'none';
  document.getElementById('confirm-devis').scrollIntoView({ block: 'end' });
}

function annulerConfirmationDevis() {
  pendingFinalAction = null;
  document.getElementById('confirm-devis').style.display = 'none';
  const iz = document.getElementById('input-zone');    if (iz) iz.style.display = '';
  const qr = document.getElementById('quick-replies'); if (qr) qr.style.display = '';
  document.getElementById('msg-input').focus();
}

async function confirmerCreationDevis() {
  if (!pendingFinalAction) return;
  const btn = document.querySelector('#confirm-devis .card-btn.primary');
  if (btn) { btn.disabled = true; btn.textContent = '...'; }

  // Les valeurs (éventuellement corrigées) des 4 champs éditables écrasent
  // celles de finalAction ; lignes / main_oeuvre / acompte restent inchangés.
  const payload = {
    ...pendingFinalAction,
    client_nom:       document.getElementById('confirm-nom').value.trim(),
    client_telephone: document.getElementById('confirm-tel').value.trim()       || null,
    client_email:     document.getElementById('confirm-email').value.trim()     || null,
    type_travaux:     document.getElementById('confirm-type').value.trim()      || null,
    reference_bien:   document.getElementById('confirm-reference').value.trim() || null
  };

  pendingFinalAction = null;
  document.getElementById('confirm-devis').style.display = 'none';
  const iz = document.getElementById('input-zone');    if (iz) iz.style.display = '';
  const qr = document.getElementById('quick-replies'); if (qr) qr.style.display = '';

  await creerDevisEtAfficher(payload);

  if (btn) { btn.disabled = false; btn.textContent = 'Confirmer et créer le devis'; }
}

// Suite identique à l'ancien comportement de sendMessage() après finalAction :
// insertion en base + maj devis_count + carte devis finale (PDF/WhatsApp/Email).
async function creerDevisEtAfficher(payload) {
  try {
    const res = await Api.createDevis(payload);
    const stored = localStorage.getItem('dp_artisan');
    if (stored) {
      const a = JSON.parse(stored);
      a.devis_count = (a.devis_count || 0) + 1;
      localStorage.setItem('dp_artisan', JSON.stringify(a));
      if (a.plan === 'gratuit') showQuotaBanner(Math.max(0, 3 - a.devis_count));
    }
    appendMessage('bot', '', {
      type:     'devis-card',
      total:    res.total,
      client:   payload.client_nom,
      numero:   res.numero,
      devis_id: res.id,
      phone:    payload.client_telephone || '',
      // Le backend renvoie l'email retenu (null si absent / invalide).
      email:    res.client_email || payload.client_email || ''
    });
    setProgress(100);
  } catch (err) {
    appendMessage('bot', `Erreur : ${err.message}`);
  }
}

// ── NAVIGATION ONGLETS ────────────────────────────────────────
// showTab colore le bouton actif ET bascule la visibilité des écrans.
// Onglet "chat" : on montre le flow bot habituel (chat, quick-replies,
// voice-confirm, input-zone, quota-banner, progress-bar) + le bouton
// "+ Nouveau" du header. Onglets "devis"/"profil" : on masque tout ça et
// on affiche l'écran dédié.
const CHAT_ELS = ['chat', 'quick-replies', 'voice-confirm', 'confirm-devis', 'input-zone', 'quota-banner', 'progress-bar'];

function showTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.nav-item').forEach((el, i) => el.classList.toggle('active', ['chat', 'devis', 'profil'][i] === tab));

  const isChat = tab === 'chat';

  // '' = on retire l'override inline → l'élément retrouve son display CSS/JS
  // d'origine (le flow chat continue de marcher exactement comme avant).
  CHAT_ELS.forEach(id => { const el = document.getElementById(id); if (el) el.style.display = isChat ? '' : 'none'; });

  const screenDevis  = document.getElementById('screen-devis');
  const screenProfil = document.getElementById('screen-profil');
  if (screenDevis)  screenDevis.style.display  = tab === 'devis'  ? 'flex' : 'none';
  if (screenProfil) screenProfil.style.display = tab === 'profil' ? 'flex' : 'none';

  const newBtn = document.getElementById('header-new-btn');
  if (newBtn) newBtn.style.display = isChat ? '' : 'none';

  if (isChat) {
    // Le quota-banner n'a un contenu que si on le régénère : on ré-évalue
    // depuis l'artisan stocké (même logique que showApp).
    const stored = localStorage.getItem('dp_artisan');
    if (stored) {
      const a = JSON.parse(stored);
      if (a.plan === 'gratuit') showQuotaBanner(Math.max(0, 3 - (a.devis_count || 0)));
    }
  }

  if (tab === 'devis')  loadDevisScreen();
  if (tab === 'profil') loadProfilScreen();
}

// ── HELPERS ───────────────────────────────────────────────────
function formatDateFr(value) {
  if (!value) return '';
  const dt = new Date(value);
  if (isNaN(dt.getTime())) return '';
  return dt.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// ── ÉCRAN DEVIS ───────────────────────────────────────────────
// Rend la liste des devis avec la même carte que celle affichée après
// création dans le chat, et réutilise les actions existantes
// (voirPDF / partagerWhatsApp / envoyerParMail).
async function loadDevisScreen() {
  const list  = document.getElementById('devis-list');
  const empty = document.getElementById('devis-empty');
  if (!list || !empty) return;
  list.innerHTML = '';
  list.style.opacity  = '';   // réarme l'affichage après un éventuel état de chargement (marquerPaye)
  empty.textContent   = "Aucun devis pour l'instant";
  empty.style.display = 'none';

  try {
    const devis = await Api.listDevis();
    if (!Array.isArray(devis) || devis.length === 0) {
      empty.style.display = 'block';
      return;
    }
    devis.forEach(d => {
      const email      = (d.client_email || '').trim();
      const hasEmail   = email.includes('@');
      const phone      = (d.client_telephone || '').replace(/'/g, '');
      const client     = (d.client_nom || '').replace(/'/g, '');

      // Un devis "marqué payé" devient une facture : le badge affiche alors le
      // numéro de facture, et le bouton "Marquer payé" disparaît (action déjà faite).
      const estFacture = !!d.numero_facture;
      const badgeHtml  = estFacture
        ? `<div style="margin-top:8px;"><span class="devis-badge">Facture ${d.numero_facture}</span></div>`
        : `<div style="margin-top:8px;"><span class="devis-badge">${d.statut || '—'}</span></div>`;
      const payeHtml   = estFacture
        ? ''
        : `<div class="devis-card-actions">
          <button class="card-btn secondary" style="flex:1"
                  onclick="marquerPaye('${d.id}')">💰 Marquer payé</button>
        </div>`;

      const card = document.createElement('div');
      card.className = 'devis-card';
      card.innerHTML = `
        <div class="devis-card-title">${d.numero || 'Devis'}</div>
        <div class="devis-card-total">${Number(d.total || 0).toLocaleString('fr-FR')} FCFA</div>
        <div class="devis-card-sub">${d.client_nom || ''}</div>
        <div class="devis-card-date">${formatDateFr(d.created_at)}</div>
        ${badgeHtml}
        <div class="devis-card-actions">
          <button class="card-btn primary"   onclick="voirPDF('${d.id}')">📄 Voir PDF</button>
          <button class="card-btn secondary" onclick="partagerWhatsApp('${d.id}', '${phone}', '${d.total}', '${client}')">💬 WhatsApp</button>
        </div>
        ${hasEmail ? `<div class="devis-card-actions">
          <button class="card-btn secondary" style="flex:1"
                  onclick="envoyerParMail('${d.id}', '${email}', this)">📧 Envoyer par mail</button>
        </div>` : ''}
        ${payeHtml}`;
      list.appendChild(card);
    });
  } catch (err) {
    empty.textContent   = "Impossible de charger les devis. Réessaie.";
    empty.style.display = 'block';
  }
}

// ── MARQUER PAYÉ → transformer un devis en facture ────────────
// Appelle le backend (idempotent : un numero_facture déjà présent est renvoyé
// tel quel, aucun second numéro généré), affiche un état de chargement pendant
// l'appel, puis rappelle loadDevisScreen() : la carte se recharge avec son
// badge "Facture …" et sans le bouton.
async function marquerPaye(devisId) {
  const list = document.getElementById('devis-list');
  if (list) list.style.opacity = '0.5';
  try {
    await Api.marquerPaye(devisId);
    await loadDevisScreen();
  } catch (err) {
    if (list) list.style.opacity = '';
    alert(`Impossible de marquer ce devis comme payé : ${err.message}`);
  }
}

// ── ÉCRAN PROFIL ──────────────────────────────────────────────
async function loadProfilScreen() {
  const msg = document.getElementById('profil-msg');
  if (msg) msg.style.display = 'none';

  try {
    const p = await Api.getProfil();
    document.getElementById('profil-nom').value             = p.nom    || '';
    document.getElementById('profil-metier').value          = p.metier || '';
    document.getElementById('profil-entreprise').value      = p.nom_entreprise || '';
    document.getElementById('profil-email').value           = p.email  || '';
    document.getElementById('profil-telephone').textContent = p.telephone || '—';
    document.getElementById('profil-plan').textContent      = p.plan   || '—';
    document.getElementById('profil-statut').textContent    = p.statut || '—';

    const quotaRow = document.getElementById('profil-quota-row');
    if (p.plan === 'gratuit') {
      quotaRow.style.display = 'flex';
      document.getElementById('profil-quota').textContent = `${p.devis_count || 0}/3 devis utilisés`;
    } else {
      quotaRow.style.display = 'none';
    }

    const expRow = document.getElementById('profil-expires-row');
    if (p.expires_at) {
      expRow.style.display = 'flex';
      document.getElementById('profil-expires').textContent = formatDateFr(p.expires_at);
    } else {
      expRow.style.display = 'none';
    }

    // Bouton "Renouveler mon abonnement" : uniquement pour les plans payants
    // (starter/pro). Le plan gratuit n'a pas d'abonnement à renouveler — juste
    // un quota à dépasser, déjà couvert par le bouton "Contacter via WhatsApp"
    // côté quota.
    const renewBtn  = document.getElementById('profil-renew-btn');
    const renewInfo = document.getElementById('profil-renew-info');
    const estPayant = p.plan && p.plan !== 'gratuit';
    if (renewBtn)  renewBtn.style.display  = estPayant ? '' : 'none';
    if (renewInfo) {
      renewInfo.style.display = estPayant ? '' : 'none';
      renewInfo.textContent   = `Paiement via Wave CI / Orange Money : ${window.DEVISPRO_PAYMENT_NUMBER}`;
    }
  } catch (err) {
    if (msg) {
      msg.textContent   = 'Impossible de charger le profil. Réessaie.';
      msg.style.color   = '#C53030';
      msg.style.display = 'block';
    }
  }
}

async function saveProfil() {
  const btn    = document.getElementById('profil-save-btn');
  const msg    = document.getElementById('profil-msg');
  const nom        = document.getElementById('profil-nom').value.trim();
  const metier     = document.getElementById('profil-metier').value.trim();
  const entreprise = document.getElementById('profil-entreprise').value.trim();
  const email      = document.getElementById('profil-email').value.trim();
  if (!nom || !metier) { alert('Le nom et le métier sont obligatoires'); return; }

  const label = btn.textContent;
  btn.disabled = true; btn.textContent = '...';
  msg.style.display = 'none';

  try {
    // email reste facultatif : jamais bloquant. Le backend applique
    // normalizeEmail() → une valeur vide ou invalide devient null.
    await Api.updateProfil({ nom, metier, email, nom_entreprise: entreprise });

    // Plutôt que de recalculer isMetierEligiblePhoto côté client, on relit le
    // profil : le backend renvoie photo_disponible à jour selon le métier.
    const p = await Api.getProfil();

    const stored = localStorage.getItem('dp_artisan');
    if (stored) {
      const a = JSON.parse(stored);
      a.nom              = p.nom;
      a.metier           = p.metier;
      a.photo_disponible = p.photo_disponible;
      localStorage.setItem('dp_artisan', JSON.stringify(a));
    }

    document.getElementById('header-sub').textContent = `Bonjour, ${p.nom} 👋`;

    // Même logique d'affichage du bouton photo que dans showApp().
    const cameraBtn = document.getElementById('camera-btn');
    if (cameraBtn) cameraBtn.style.display = p.photo_disponible === false ? 'none' : '';

    msg.textContent   = '✅ Modifications enregistrées';
    msg.style.color   = '#2F855A';
    msg.style.display = 'block';
  } catch (err) {
    msg.textContent   = `Échec de l'enregistrement : ${err.message}`;
    msg.style.color   = '#C53030';
    msg.style.display = 'block';
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
}

// ── RENOUVELLEMENT D'ABONNEMENT (plans payants) ───────────────
// Réutilise contacterAdminWhatsApp() — même mécanique que le bouton quota,
// message adapté au renouvellement. Message de secours générique si l'artisan
// stocké est indisponible, plutôt que de planter.
function renouvelerAbonnement() {
  const stored = localStorage.getItem('dp_artisan');
  const a = stored ? JSON.parse(stored) : null;
  const message = a
    ? `Bonjour, je souhaite renouveler mon abonnement DevisPro CI. Nom : ${a.nom}, Téléphone : ${a.telephone}, Plan actuel : ${a.plan}.`
    : "Bonjour, je souhaite renouveler mon abonnement DevisPro CI.";
  contacterAdminWhatsApp(message);
}

function logout() {
  if (!confirm('Se déconnecter de DevisPro CI ?')) return;
  Api.clearToken();
  window.location.reload();
}