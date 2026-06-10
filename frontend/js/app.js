// ── app.js — Contrôleur principal DevisPro CI ─────────────────

// ── PWA install prompt ─────────────────────────────────────────
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstallPrompt = e;
  document.getElementById('install-banner').classList.add('show');
});

function installPWA() {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  deferredInstallPrompt.userChoice.then(() => dismissInstall());
}
function dismissInstall() {
  document.getElementById('install-banner').classList.remove('show');
}

// ── Service Worker ─────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(console.error);
}

// ── State ──────────────────────────────────────────────────────
let authMode   = 'login';
let currentTab = 'chat';

// ── Auth ───────────────────────────────────────────────────────
function toggleAuthMode() {
  authMode = authMode === 'login' ? 'register' : 'login';
  const rf   = document.getElementById('register-fields');
  const btn  = document.getElementById('auth-submit-btn');
  const link = document.getElementById('auth-toggle-link');
  rf.style.display  = authMode === 'register' ? 'flex' : 'none';
  btn.textContent   = authMode === 'register' ? 'Créer mon compte' : 'Se connecter';
  link.innerHTML    = authMode === 'register'
    ? 'Déjà inscrit ? <span onclick="toggleAuthMode()">Se connecter</span>'
    : 'Pas encore inscrit ? <span onclick="toggleAuthMode()">Créer un compte</span>';
}

async function submitAuth() {
  const tel  = document.getElementById('auth-tel').value.trim();
  const pass = document.getElementById('auth-pass').value;
  const btn  = document.getElementById('auth-submit-btn');
  if (!tel || !pass) return alert('Remplis tous les champs');
  btn.textContent = '...';
  btn.disabled    = true;
  try {
    let res;
    if (authMode === 'login') {
      res = await Api.login(tel, pass);
    } else {
      const nom    = document.getElementById('auth-nom').value.trim();
      const metier = document.getElementById('auth-metier').value.trim();
      if (!nom || !metier) { alert('Remplis ton nom et ton métier'); return; }
      res = await Api.register(nom, tel, metier, pass);
    }
    Api.setToken(res.token);
    localStorage.setItem('dp_artisan', JSON.stringify(res.artisan));
    showApp(res.artisan);
  } catch (err) {
    alert(err.message || 'Erreur de connexion');
  } finally {
    btn.disabled    = false;
    btn.textContent = authMode === 'login' ? 'Se connecter' : 'Créer mon compte';
  }
}

function showApp(artisan) {
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  document.getElementById('header-sub').textContent = `Bonjour, ${artisan.nom} 👋`;
  startBotGreeting(artisan);
}

// ── Auto-login si token existant ───────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  const stored = localStorage.getItem('dp_artisan');
  if (Api.token && stored) {
    showApp(JSON.parse(stored));
  }
});

// ── Chat UI ────────────────────────────────────────────────────
function appendMessage(role, text, extra) {
  const chat = document.getElementById('chat');
  const div  = document.createElement('div');
  div.className = `msg ${role}`;

  const avatar = document.createElement('div');
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
  div.innerHTML = `<div class="msg-avatar">🤖</div>
    <div class="msg-bubble"><div class="typing"><span></span><span></span><span></span></div></div>`;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
}

function hideTyping() {
  const t = document.getElementById('typing-indicator');
  if (t) t.remove();
}

function setQuickReplies(options) {
  const qr = document.getElementById('quick-replies');
  qr.innerHTML = '';
  options.forEach(opt => {
    const btn = document.createElement('button');
    btn.className = 'qr-btn';
    btn.textContent = opt;
    btn.onclick = () => { setInput(opt); sendMessage(); };
    qr.appendChild(btn);
  });
}

function setProgress(pct) {
  document.getElementById('progress-fill').style.width = `${pct}%`;
}

function setInput(text) {
  const inp = document.getElementById('msg-input');
  inp.value = text;
  autoResize(inp);
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 100) + 'px';
}

function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

// ══════════════════════════════════════════════════════════════
// RECONNAISSANCE VOCALE
// ══════════════════════════════════════════════════════════════

let recognition    = null;
let isListening    = false;
let pendingTranscript = null; // texte en attente de confirmation

function initSpeech() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return null;
  const r = new SpeechRecognition();
  r.lang          = 'fr-FR';
  r.continuous    = false;
  r.interimResults = true;

  r.onstart = () => {
    isListening = true;
    setMicState('listening');
  };

  r.onresult = (e) => {
    let interim = '';
    let final   = '';
    for (const res of e.results) {
      if (res.isFinal) final   += res[0].transcript;
      else             interim += res[0].transcript;
    }
    // Affiche en temps réel dans l'input
    const inp = document.getElementById('msg-input');
    inp.value = final || interim;
    autoResize(inp);
  };

  r.onend = () => {
    isListening = false;
    setMicState('idle');
    const transcript = document.getElementById('msg-input').value.trim();
    if (transcript) {
      showVoiceConfirm(transcript);
    }
  };

  r.onerror = (e) => {
    isListening = false;
    setMicState('idle');
    if (e.error !== 'no-speech') {
      appendMessage('bot', "Micro non accessible. Vérifie les permissions.");
    }
  };

  return r;
}

function toggleMic() {
  if (!recognition) recognition = initSpeech();
  if (!recognition) {
    alert("Ton navigateur ne supporte pas la reconnaissance vocale. Utilise Chrome.");
    return;
  }
  if (isListening) {
    recognition.stop();
  } else {
    // Effacer confirmation en cours si elle existe
    hideVoiceConfirm();
    document.getElementById('msg-input').value = '';
    recognition.start();
  }
}

function setMicState(state) {
  const btn = document.getElementById('mic-btn');
  if (!btn) return;
  if (state === 'listening') {
    btn.classList.add('listening');
    btn.title = 'Parle... (clic pour arrêter)';
  } else {
    btn.classList.remove('listening');
    btn.title = 'Parler';
  }
}

// ── Confirmation vocale ────────────────────────────────────────
function showVoiceConfirm(transcript) {
  pendingTranscript = transcript;
  const zone = document.getElementById('voice-confirm');
  const txt  = document.getElementById('voice-confirm-text');
  txt.textContent  = `"${transcript}"`;
  zone.style.display = 'flex';
}

function hideVoiceConfirm() {
  const zone = document.getElementById('voice-confirm');
  zone.style.display = 'none';
  pendingTranscript  = null;
}

function confirmVoice(confirmed) {
  hideVoiceConfirm();
  if (confirmed && pendingTranscript) {
    // déjà dans l'input, on envoie directement
    sendMessage();
  } else {
    // Annuler → vider l'input et relancer le micro
    document.getElementById('msg-input').value = '';
    toggleMic();
  }
}

// ── Bot interaction ────────────────────────────────────────────
async function startBotGreeting(artisan) {
  Bot.reset();
  const greeting = `Bonjour ${artisan.nom} ! 👋 Je suis prêt à t'aider à créer un devis professionnel. Appuie sur "Nouveau devis" ou dis-moi directement : quel client aujourd'hui ?`;
  setTimeout(() => {
    appendMessage('bot', greeting);
    setQuickReplies(['Nouveau devis']);
  }, 600);
}

function newDevis() {
  Bot.reset();
  document.getElementById('chat').innerHTML = '';
  setQuickReplies([]);
  hideVoiceConfirm();
  showTyping();
  setTimeout(() => {
    hideTyping();
    appendMessage('bot', "C'est parti ! Quel est le nom de ton client ?");
    document.getElementById('msg-input').focus();
  }, 500);
}

async function sendMessage() {
  const inp  = document.getElementById('msg-input');
  const text = inp.value.trim();
  if (!text) return;

  inp.value = '';
  autoResize(inp);
  setQuickReplies([]);
  hideVoiceConfirm();
  document.getElementById('send-btn').disabled = true;

  appendMessage('user', text);
  showTyping();

  try {
    const { reply, quickReplies, finalAction } = await Bot.send(text);
    hideTyping();

    if (finalAction) {
      try {
        const res = await Api.createDevis(finalAction);
        appendMessage('bot', reply);
        appendMessage('bot', '', {
          type: 'devis-card',
          total: res.total,
          client: finalAction.client_nom,
          numero: res.numero,
          pdf_url: res.pdf_url,
          phone: finalAction.client_telephone || ''
        });
        setProgress(100);
      } catch (err) {
        appendMessage('bot', `Erreur lors de la création du devis : ${err.message}`);
      }
    } else {
      appendMessage('bot', reply);
      if (quickReplies && quickReplies.length) setQuickReplies(quickReplies);
    }
  } catch {
    hideTyping();
    appendMessage('bot', "Une erreur s'est produite. Réessaie.");
  } finally {
    document.getElementById('send-btn').disabled = false;
  }
}

// ── WhatsApp share ─────────────────────────────────────────────
function shareWhatsApp(phone, pdfUrl, total) {
  const msg = encodeURIComponent(
    `Bonjour,\n\nVeuillez trouver ci-joint votre devis — Montant total : ${Number(total).toLocaleString('fr-FR')} FCFA.\n\nConsultez le PDF : ${window.location.origin}${pdfUrl}\n\nCordialement,\nDevisPro CI`
  );
  const num = phone.replace(/\D/g, '');
  window.open(`https://wa.me/${num}?text=${msg}`, '_blank');
}

// ── Tabs ───────────────────────────────────────────────────────
function showTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.nav-item').forEach((el, i) => {
    el.classList.toggle('active', ['chat','devis','profil'][i] === tab);
  });
}
