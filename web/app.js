const $ = (sel) => document.querySelector(sel);

const state = {
  guideText: '',        // original study guide text (ground truth for follow-ups)
  cards: [],           // current round's cards
  index: 0,
  missed: [],          // cards marked "don't know" this round
  round: 1,
  flipped: false,
  answering: false,
};

// ---------- screen helpers ----------
function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
}

function setStep(name) {
  const order = ['read', 'gen', 'verify'];
  const i = order.indexOf(name);
  document.querySelectorAll('#loading-steps li').forEach((li, idx) => {
    li.classList.remove('doing', 'done');
    if (idx < i) li.classList.add('done');
    else if (idx === i) li.classList.add('doing');
  });
}

function showError(sel, msg) {
  const el = $(sel);
  el.textContent = msg;
  el.classList.remove('hidden');
}

// Quick client-side gate so we can bail before the loading screen / LLM call.
// Keep thresholds in sync with server/prompts.js.
const MIN_GUIDE_CHARS = 80;
const MIN_GUIDE_WORDS = 12;
function looksLikeStudyMaterial(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length < MIN_GUIDE_CHARS) return false;
  const words = t.split(' ').filter((w) => /[\p{L}\p{N}]/u.test(w));
  return words.length >= MIN_GUIDE_WORDS;
}

let elapsedTimer = null;
function startElapsed() {
  stopElapsed();
  const t0 = Date.now();
  $('#loading-elapsed').textContent = '0s elapsed';
  elapsedTimer = setInterval(() => {
    const s = Math.floor((Date.now() - t0) / 1000);
    $('#loading-elapsed').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} elapsed`;
  }, 1000);
}
function stopElapsed() {
  if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
}
function setLoadingSub(msg) {
  $('#loading-sub').textContent = msg;
}

async function api(path, body, method) {
  const m = method || (body === undefined ? 'GET' : 'POST');
  const res = await fetch(path, {
    method: m,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// POST that consumes an SSE stream; onProgress fires for each progress event.
async function apiStream(path, body, onProgress) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let result = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const rawEvent = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = 'message';
      let data = '';
      for (const line of rawEvent.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      let parsed;
      try { parsed = JSON.parse(data); } catch { continue; }
      if (event === 'done') result = parsed;
      else if (event === 'error') throw new Error(parsed.error || 'Stream error');
      else if (event === 'progress' && onProgress) onProgress(parsed);
    }
  }
  if (!result) throw new Error('Stream ended without a result');
  return result;
}

// ---------- upload ----------
const dropzone = $('#dropzone');
const fileInput = $('#file-input');
const cardCountInput = $('#card-count');
let imageBase64 = null;

const CARD_COUNT_KEY = 'flashcard-studio.cardCount';

function restoreCardCount() {
  const saved = parseInt(localStorage.getItem(CARD_COUNT_KEY), 10);
  if (Number.isFinite(saved)) {
    cardCountInput.value = Math.min(50, Math.max(5, saved));
  }
  $('#card-count-value').textContent = cardCountInput.value;
}

cardCountInput.addEventListener('input', () => {
  $('#card-count-value').textContent = cardCountInput.value;
  localStorage.setItem(CARD_COUNT_KEY, cardCountInput.value);
});

dropzone.addEventListener('click', () => fileInput.click());
['dragover', 'dragenter'].forEach(ev => dropzone.addEventListener(ev, e => {
  e.preventDefault();
  dropzone.classList.add('dragover');
}));
['dragleave', 'drop'].forEach(ev => dropzone.addEventListener(ev, e => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
}));
dropzone.addEventListener('drop', e => {
  const file = e.dataTransfer.files?.[0];
  if (file && file.type.startsWith('image/')) loadFile(file);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files?.[0]) loadFile(fileInput.files[0]);
});

function loadFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    imageBase64 = reader.result; // data:image/...;base64,...
    const preview = $('#preview');
    preview.src = imageBase64;
    preview.classList.remove('hidden');
    $('#drop-prompt').classList.add('hidden');
  };
  reader.readAsDataURL(file);
}

$('#btn-start').addEventListener('click', async () => {
  $('#upload-error').classList.add('hidden');
  const text = $('#guide-text').value.trim();
  if (!text && !imageBase64) {
    showError('#upload-error', "We can't see any study material — paste the study guide text or drop a photo of it.");
    return;
  }
  if (text && !looksLikeStudyMaterial(text)) {
    showError('#upload-error', "We can't see any real study material there — that looks too short. Paste the full study guide (a sentence or two isn't enough).");
    return;
  }

  show('#screen-loading');
  $('#loading-title').textContent = 'Reading your study guide…';
  $('#loading-steps').classList.remove('hidden');
  setStep('read');
  startElapsed();

  try {
    let guide = text;
    if (!guide && imageBase64) {
      setLoadingSub('Transcribing your photo with the vision model — this can take a while…');
      const t = await api('/api/transcribe', { image: imageBase64 });
      guide = t.text;
      if (!guide || !looksLikeStudyMaterial(guide)) {
        throw new Error("We couldn't see any study material in that photo — try a clearer, well-lit picture of the full page.");
      }
      setLoadingSub(`Read ${guide.length} characters from your photo.`);
    } else {
      setLoadingSub(`Read ${guide.length} characters of guide text.`);
    }
    state.guideText = guide;

    const count = cardCountInput.value;
    $('#loading-title').textContent = 'Writing your flashcards…';
    setStep('gen');
    setLoadingSub(`Asking the model for ${count} cards from your guide…`);
    let deck = await apiStream('/api/generate/stream', { text: guide, count }, (p) => {
      setLoadingSub(`Written ${p.created} of ${p.total} flashcards…`);
    });

    $('#loading-title').textContent = 'Double-checking answers…';
    setStep('verify');
    setLoadingSub(`Checking ${deck.cards.length} answers against your guide…`);
    try {
      deck = await apiStream('/api/verify/stream', { text: guide, deck }, (p) => {
        setLoadingSub(`Checked ${p.checked} of ${p.total} answers…`);
      });
    } catch (err) {
      console.warn('verification pass failed, using unverified draft:', err.message);
    }
    setLoadingSub(`Verified ${deck.cards.length} answers against your guide.`);
    setStep('done');
    stopElapsed();

    saveDeckRemote(deck, guide);
    startRound(deck.cards, state.round);
  } catch (err) {
    stopElapsed();
    show('#screen-upload');
    showError('#upload-error', err.message);
  }
});

// ---------- study ----------
function startRound(cards, round) {
  state.cards = cards;
  state.index = 0;
  state.missed = [];
  state.round = round;
  $('#deck-topic').textContent = `Round ${round} · ${cards.length} cards`;
  $('#deck-topic').classList.remove('hidden');
  $('#round-label').textContent = round === 1 ? 'Round 1' : `Follow-up round ${round - 1}`;
  show('#screen-study');
  renderCard();
}

const FLIP_MS = 580; // must be >= the .card-inner transition duration in styles.css

function renderCardContent() {
  const c = state.cards[state.index];
  $('#card-question').textContent = c.question;
  $('#card-answer').textContent = c.answer;
  updateProgress();
  $('#card').focus({ preventScroll: true });
}

function renderCard() {
  const card = $('#card');
  if (card.classList.contains('flipped')) {
    // flip back to the question side first; swap text only after the flip
    // completes so the next card's answer is never visible mid-flip
    card.classList.remove('flipped', 'shake-left', 'pop-right');
    state.flipped = false;
    state.answering = true;
    setTimeout(() => {
      renderCardContent();
      state.answering = false;
    }, FLIP_MS);
  } else {
    card.classList.remove('shake-left', 'pop-right');
    renderCardContent();
  }
}

function updateProgress() {
  const total = state.cards.length;
  const done = state.index;
  $('#progress-fill').style.width = `${(done / total) * 100}%`;
  $('#progress-count').textContent = `${done + 1} / ${total}`;
}

function flip() {
  if (state.answering) return;
  state.flipped = !state.flipped;
  $('#card').classList.toggle('flipped', state.flipped);
}

function answer(knew) {
  if (state.answering) return;
  if (!state.flipped) { flip(); return; }
  state.answering = true;

  const card = $('#card');
  card.classList.add(knew ? 'pop-right' : 'shake-left');
  if (!knew) state.missed.push(state.cards[state.index]);

  setTimeout(() => {
    state.answering = false;
    state.index++;
    if (state.index >= state.cards.length) {
      finishRound();
    } else {
      renderCard();
    }
  }, 320);
}

$('#card').addEventListener('click', flip);
$('#btn-gotit').addEventListener('click', () => answer(true));
$('#btn-dunno').addEventListener('click', () => answer(false));

document.addEventListener('keydown', (e) => {
  if (!$('#screen-study').classList.contains('active')) return;
  if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); answer(true); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); answer(false); }
  else if (e.key === 'Escape') {
    if (isConfirmOpen()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    endSession();
  }
});

// ---------- round complete ----------
function finishRound() {
  $('#progress-fill').style.width = '100%';
  const total = state.cards.length;
  const got = total - state.missed.length;
  const perfect = state.missed.length === 0;

  $('#done-emoji').textContent = perfect ? '🏆' : got >= total / 2 ? '🎉' : '💪';
  $('#done-title').textContent = perfect ? 'Perfect round!' : 'Round complete!';
  $('#done-summary').textContent = `You knew ${got} out of ${total} cards.`;

  const missedWrap = $('#missed-list-wrap');
  const followBtn = $('#btn-followup');
  $('#followup-error').classList.add('hidden');

  if (perfect) {
    missedWrap.classList.add('hidden');
    followBtn.classList.add('hidden');
  } else {
    missedWrap.classList.remove('hidden');
    followBtn.classList.remove('hidden');
    const ul = $('#missed-list');
    ul.innerHTML = '';
    state.missed.forEach(c => {
      const li = document.createElement('li');
      li.textContent = c.question;
      ul.appendChild(li);
    });
  }
  show('#screen-done');
}

$('#btn-followup').addEventListener('click', async () => {
  const btn = $('#btn-followup');
  btn.disabled = true;
  $('#followup-error').classList.add('hidden');

  show('#screen-loading');
  $('#loading-title').textContent = 'Making a follow-up deck…';
  $('#loading-steps').classList.add('hidden');
  setLoadingSub(`Writing fresh questions on ${state.missed.length} missed concept${state.missed.length === 1 ? '' : 's'}…`);
  startElapsed();

  try {
    const deck = await api('/api/followup', {
      text: state.guideText,
      missed: state.missed.map(c => ({ question: c.question, answer: c.answer })),
    });
    stopElapsed();
    saveDeckRemote(deck, state.guideText);
    startRound(deck.cards, state.round + 1);
  } catch (err) {
    stopElapsed();
    show('#screen-done');
    showError('#followup-error', err.message);
  } finally {
    btn.disabled = false;
  }
});

$('#btn-restart').addEventListener('click', backToUpload);
$('#btn-end').addEventListener('click', endSession);

function endSession() {
  if (state.answering) return;
  const progress = state.index > 0
    ? `You're on card ${state.index + 1} of ${state.cards.length}. `
    : '';
  openConfirm({
    emoji: '👋',
    title: 'End this session?',
    text: `${progress}Your saved deck will still be on the main screen.`,
    confirmLabel: 'End session',
    cancelLabel: 'Keep studying',
    danger: false,
    onConfirm: () => {
      closeConfirm();
      backToUpload();
    },
  });
}

function backToUpload() {
  state.guideText = '';
  state.cards = [];
  state.round = 1;
  imageBase64 = null;
  $('#guide-text').value = '';
  $('#preview').classList.add('hidden');
  $('#drop-prompt').classList.remove('hidden');
  $('#deck-topic').classList.add('hidden');
  refreshSavedDecks();
  show('#screen-upload');
}

// ---------- saved decks ----------
async function saveDeckRemote(deck, guideText) {
  try {
    await api('/api/decks', { topic: deck.topic, cards: deck.cards, guideText: guideText || '' });
    refreshSavedDecks();
    toast('✓ Deck saved to your library');
  } catch (err) {
    console.warn('could not save deck:', err.message);
    toast('⚠ Deck could not be saved');
  }
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.remove('show'), 2600);
}

async function refreshSavedDecks() {
  try {
    const { decks } = await api('/api/decks');
    const wrap = $('#saved-decks');
    const ul = $('#saved-decks-list');
    ul.innerHTML = '';
    if (!decks.length) {
      wrap.classList.add('hidden');
      return;
    }
    wrap.classList.remove('hidden');
    for (const d of decks) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.className = 'btn saved-deck-btn';
      const name = document.createElement('span');
      name.className = 'saved-deck-name';
      name.textContent = `📚 ${d.topic}`;
      const meta = document.createElement('span');
      meta.className = 'saved-deck-meta';
      const when = new Date(d.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      meta.textContent = `${d.cardCount} cards · saved ${when}`;
      btn.append(name, meta);
      btn.addEventListener('click', () => loadSavedDeck(d.id));
      const trash = document.createElement('button');
      trash.className = 'deck-delete';
      trash.type = 'button';
      trash.title = `Delete "${d.topic}"`;
      trash.setAttribute('aria-label', `Delete ${d.topic}`);
      trash.textContent = '🗑';
      trash.addEventListener('click', (e) => {
        e.stopPropagation();
        openDeleteModal(d.id, d.topic, d.cardCount);
      });
      li.append(btn, trash);
      ul.appendChild(li);
    }
  } catch {
    /* saved decks are optional; ignore fetch failures */
  }
}

async function loadSavedDeck(id) {
  $('#upload-error').classList.add('hidden');
  try {
    const deck = await api(`/api/decks/${id}`);
    state.guideText = deck.guideText || '';
    state.round = 1;
    startRound(deck.cards, 1);
  } catch (err) {
    showError('#upload-error', err.message);
  }
}

// ---------- confirm modal (shared by delete-deck + end-session) ----------
let confirmCallback = null;

function isConfirmOpen() {
  return !$('#confirm-modal').classList.contains('hidden');
}

function openConfirm({ emoji, title, text, warn, confirmLabel, cancelLabel, danger = true, onConfirm }) {
  const emojiEl = $('#confirm-modal-emoji');
  emojiEl.textContent = emoji || '';
  emojiEl.classList.toggle('hidden', !emoji);
  $('#confirm-modal-title').textContent = title || '';
  $('#confirm-modal-text').textContent = text || '';
  const warnEl = $('#confirm-modal-warn');
  warnEl.textContent = warn || '';
  warnEl.classList.toggle('hidden', !warn);
  const okBtn = $('#btn-confirm-ok');
  okBtn.textContent = confirmLabel || 'Confirm';
  okBtn.className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');
  $('#btn-confirm-cancel').textContent = cancelLabel || 'Cancel';
  confirmCallback = onConfirm || null;
  $('#confirm-modal').classList.remove('hidden');
  okBtn.focus({ preventScroll: true });
}

function closeConfirm() {
  confirmCallback = null;
  $('#confirm-modal').classList.add('hidden');
}

$('#btn-confirm-cancel').addEventListener('click', closeConfirm);
$('#confirm-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeConfirm();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isConfirmOpen()) {
    e.preventDefault();
    closeConfirm();
  }
});
$('#btn-confirm-ok').addEventListener('click', () => {
  const cb = confirmCallback;
  if (!cb) { closeConfirm(); return; }
  cb($('#btn-confirm-ok'));
});

function openDeleteModal(id, topic, cardCount) {
  openConfirm({
    emoji: '🗑️',
    title: 'Delete these flashcards?',
    text: `"${topic}" (${cardCount} cards) will be permanently removed from your saved decks.`,
    warn: "This can't be undone — you'd have to regenerate the deck with the LLM.",
    confirmLabel: 'Yes, delete',
    cancelLabel: 'Keep them',
    danger: true,
    onConfirm: async (btn) => {
      btn.disabled = true;
      try {
        await api(`/api/decks/${id}`, undefined, 'DELETE');
        closeConfirm();
        refreshSavedDecks();
      } catch (err) {
        $('#confirm-modal-text').textContent = `Delete failed: ${err.message}`;
      } finally {
        btn.disabled = false;
      }
    },
  });
}

// ---------- boot ----------
restoreCardCount();
refreshSavedDecks();
api('/api/health').then(h => {
  $('#endpoint-label').textContent = h.endpoint.baseUrl;
}).catch(() => {
  $('#endpoint-label').textContent = 'LLM endpoint unknown';
});
