// ── app.js v4 — fix login en_attente + token temp ─────────────

// ── PWA ───────────────────────────────────────────────────────
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault(); deferredInstallPrompt = e;
  document.getElementById('install-banner').classList.add('show');
});
function installPWA() { if (!deferredInstallPrompt) return; deferredInstallPrompt.prompt(); deferredInstallPrompt.userChoice.then(() => dismissInstall()); }
function dismissInstall() { document.getElementById('install-banner').classList.remove('show'); }
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(console.error);

// ── STATE ──────────────────────────────────────────────────────
let authMode   = 'login';
let currentTab = 'chat';

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

      // Compte en attente : sauvegarder le token temporaire + afficher écran code
      if (res.statut === 'en_attente') {
        if (res.token) Api.setToken(res.token);
        showPendingScreen();
        return;
      }

      // Compte suspendu ou expiré
      if (res.statut === 'suspendu' || res.statut === 'expiré') {
        alert('Abonnement expiré ou compte suspendu. Contactez l\'administrateur.');
        return;
      }

      // Connexion normale → accès app
      Api.setToken(res.token);
      localStorage.setItem('dp_artisan', JSON.stringify(res.artisan));
      showApp(res.artisan);

    } else {
      const nom    = document.getElementById('auth-nom').value.trim();
      const metier = document.getElementById('auth-metier').value.trim();
      if (!nom || !metier) { alert('Remplis ton nom et ton métier'); return; }
      const res = await Api.register(nom, tel, metier, pass);
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
  if (!code) { err.textContent = "Entre ton code d'activation"; err.style.display = 'block'; return; }
  if (!Api.token) { err.textContent = 'Session expirée. Reconnecte-toi.'; err.style.display = 'block'; return; }

  btn.textContent = '...'; btn.disabled = true;
  try {
    const res = await Api.activateCode(code);
    Api.setToken(res.token);
    localStorage.setItem('dp_artisan', JSON.stringify(res.artisan));
    document.getElementById('activation-screen').style.display = 'none';
    showApp(res.artisan);
  } catch (err2) {
    err.textContent   = err2.message || 'Code invalide';
    err.style.display = 'block';
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Activer mon compte';
  }
}

function showApp(artisan) {
  document.getElementById('auth-screen').style.display       = 'none';
  document.getElementById('activation-screen').style.display = 'none';
  document.getElementById('app').style.display               = 'flex';
  document.getElementById('header-sub').textContent = `Bonjour, ${artisan.nom} 👋`;
  if (artisan.plan === 'gratuit') {
    const restants = Math.max(0, 3 - (artisan.devis_count || 0));
    showQuotaBanner(restants);
  }
  startBotGreeting(artisan);
}

// ── AUTO-LOGIN ─────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  const stored = localStorage.getItem('dp_artisan');
  if (Api.token && stored) showApp(JSON.parse(stored));
});

// ── QUOTA BANNER ───────────────────────────────────────────────
function showQuotaBanner(restants) {
  const banner = document.getElementById('quota-banner');
  if (!banner) return;
  if (restants === 0) {
    banner.innerHTML        = `🔒 Vous avez utilisé vos 3 devis gratuits. <a href="#" onclick="showUpgradeMessage()" style="color:var(--gold);font-weight:700;">S'abonner →</a>`;
    banner.style.background = '#FED7D7';
    banner.style.color      = '#C53030';
  } else {
    banner.innerHTML        = `⚡ Plan gratuit : ${restants} devis restant${restants > 1 ? 's' : ''}`;
    banner.style.background = restants === 1 ? '#FEFCBF' : '#EBF8FF';
    banner.style.color      = restants === 1 ? '#744210' : '#2B6CB0';
  }
  banner.style.display = 'block';
}

function showUpgradeMessage() {
  appendMessage('bot', 'Pour continuer, abonnez-vous au plan Starter à 1 000 FCFA/mois.\n\nEnvoyez "STARTER" par WhatsApp pour activer votre abonnement.');
  setQuickReplies(['Contacter via WhatsApp']);
}

// ── CHAT UI ────────────────────────────────────────────────────
function appendMessage(role, text, extra) {
  const chat   = document.getElementById('chat');
  const div    = document.createElement('div');
  div.className = `msg ${role}`;
  const avatar  = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.textContent = role === 'bot' ? '🤖' : '👷';
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  if (extra && extra.type === 'devis-card') {
    bubble.innerHTML = `
      <div class="devis-card">
        <div class="devis-card-title">Devis généré</div>
        <div class="devis-card-total">${extra.total.toLocaleString('fr-FR')} FCFA</div>
        <div class="devis-card-sub">${extra.client} · ${extra.numero}</div>
        <div class="devis-card-actions">
          <button class="card-btn primary" onclick="window.open('${extra.pdf_url}','_blank')">📄 Voir PDF</button>
          <button class="card-btn secondary" onclick="shareWhatsApp('${extra.phone}','${extra.pdf_url}','${extra.total}')">💬 WhatsApp</button>
        </div>
      </div>`;
  } else {
    bubble.textContent = text;
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
    const btn     = document.createElement('button');
    btn.className = 'qr-btn'; btn.textContent = opt;
    btn.onclick   = () => {
      if (opt === 'Contacter via WhatsApp') { window.open('https://wa.me/[TON_NUMERO]?text=STARTER', '_blank'); return; }
      setInput(opt); sendMessage();
    };
    qr.appendChild(btn);
  });
}

function setProgress(pct) { document.getElementById('progress-fill').style.width = `${pct}%`; }
function setInput(text)   { const inp = document.getElementById('msg-input'); inp.value = text; autoResize(inp); }
function autoResize(el)   { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 100) + 'px'; }
function handleKey(e)     { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }

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
  r.onend    = () => { isListening = false; setMicState('idle'); const t = document.getElementById('msg-input').value.trim(); if (t) showVoiceConfirm(t); };
  r.onerror  = (e) => { isListening = false; setMicState('idle'); if (e.error !== 'no-speech') appendMessage('bot', 'Micro non accessible.'); };
  return r;
}

function toggleMic() {
  if (!recognition) recognition = initSpeech();
  if (!recognition) { alert('Utilise Chrome pour la reconnaissance vocale.'); return; }
  if (isListening) { recognition.stop(); }
  else { hideVoiceConfirm(); document.getElementById('msg-input').value = ''; recognition.start(); }
}
function setMicState(state)      { const btn = document.getElementById('mic-btn'); if (!btn) return; btn.classList.toggle('listening', state === 'listening'); }
function showVoiceConfirm(transcript) { pendingTranscript = transcript; document.getElementById('voice-confirm-text').textContent = `"${transcript}"`; document.getElementById('voice-confirm').style.display = 'flex'; }
function hideVoiceConfirm()      { document.getElementById('voice-confirm').style.display = 'none'; pendingTranscript = null; }
function confirmVoice(confirmed) { hideVoiceConfirm(); if (confirmed && pendingTranscript) { sendMessage(); } else { document.getElementById('msg-input').value = ''; toggleMic(); } }

// ── BOT ────────────────────────────────────────────────────────
async function startBotGreeting(artisan) {
  Bot.reset();
  setTimeout(() => {
    appendMessage('bot', `Bonjour ${artisan.nom} ! 👋 Je suis prêt à t'aider à créer un devis professionnel. Appuie sur "Nouveau devis" ou dis-moi directement : quel client aujourd'hui ?`);
    setQuickReplies(['Nouveau devis']);
  }, 600);
}

function newDevis() {
  const stored = localStorage.getItem('dp_artisan');
  if (stored) {
    const a = JSON.parse(stored);
    if (a.plan === 'gratuit' && a.devis_count >= 3) {
      appendMessage('bot', '🔒 Vous avez utilisé vos 3 devis gratuits. Abonnez-vous pour continuer.');
      setQuickReplies(['Contacter via WhatsApp']);
      return;
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
  const inp = document.getElementById('msg-input');
  const text = inp.value.trim(); if (!text) return;
  inp.value = ''; autoResize(inp); setQuickReplies([]); hideVoiceConfirm();
  document.getElementById('send-btn').disabled = true;
  appendMessage('user', text); showTyping();
  try {
    const { reply, quickReplies, finalAction } = await Bot.send(text);
    hideTyping();
    if (reply && reply.includes('devis gratuits')) { appendMessage('bot', reply); setQuickReplies(['Contacter via WhatsApp']); return; }
    if (finalAction) {
      try {
        const res = await Api.createDevis(finalAction);
        const stored = localStorage.getItem('dp_artisan');
        if (stored) {
          const a = JSON.parse(stored);
          a.devis_count = (a.devis_count || 0) + 1;
          localStorage.setItem('dp_artisan', JSON.stringify(a));
          if (a.plan === 'gratuit') showQuotaBanner(Math.max(0, 3 - a.devis_count));
        }
        appendMessage('bot', reply);
        appendMessage('bot', '', { type: 'devis-card', total: res.total, client: finalAction.client_nom, numero: res.numero, pdf_url: res.pdf_url, phone: finalAction.client_telephone || '' });
        setProgress(100);
      } catch (err) { appendMessage('bot', `Erreur : ${err.message}`); }
    } else {
      appendMessage('bot', reply);
      if (quickReplies && quickReplies.length) setQuickReplies(quickReplies);
    }
  } catch { hideTyping(); appendMessage('bot', "Une erreur s'est produite. Réessaie."); }
  finally { document.getElementById('send-btn').disabled = false; }
}

function shareWhatsApp(phone, pdfUrl, total) {
  const msg = encodeURIComponent(`Bonjour,\n\nVeuillez trouver votre devis — Montant : ${Number(total).toLocaleString('fr-FR')} FCFA.\n\nPDF : ${window.location.origin}${pdfUrl}\n\nCordialement,\nDevisPro CI`);
  window.open(`https://wa.me/${phone.replace(/\D/g, '')}?text=${msg}`, '_blank');
}

function showTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.nav-item').forEach((el, i) => el.classList.toggle('active', ['chat', 'devis', 'profil'][i] === tab));
}