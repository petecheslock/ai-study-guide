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

// ---------- upload ----------
const dropzone = $('#dropzone');
const fileInput = $('#file-input');
const cardCountInput = $('#card-count');
let imageBase64 = null;

cardCountInput.addEventListener('input', () => {
  $('#card-count-value').textContent = cardCountInput.value;
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
    showError('#upload-error', 'Paste some text or add a photo of the study guide first.');
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
      if (!guide || guide.length < 20) throw new Error('Could not read any text from that photo — try a clearer picture.');
      setLoadingSub(`Read ${guide.length} characters from your photo.`);
    } else {
      setLoadingSub(`Read ${guide.length} characters of guide text.`);
    }
    state.guideText = guide;

    const count = cardCountInput.value;
    $('#loading-title').textContent = 'Writing your flashcards…';
    setStep('gen');
    setLoadingSub(`Asking the model for ${count} cards, then double-checking every answer against your guide…`);
    const deck = await api('/api/generate', { text: guide, count });

    $('#loading-title').textContent = 'Double-checking answers…';
    setStep('verify');
    setLoadingSub(`Verified ${deck.cards.length} answers against your guide.`);
    // verification already happened server-side; mark done while deck settles
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
  else if (e.key === 'Escape') { e.preventDefault(); endSession(); }
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
    ? `You're on card ${state.index + 1} of ${state.cards.length}.`
    : '';
  if (!confirm(`End this session? ${progress} Your saved deck will still be on the main screen.`)) return;
  backToUpload();
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
  } catch (err) {
    console.warn('could not save deck:', err.message);
  }
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

// ---------- delete-deck modal ----------
let pendingDeleteId = null;

function openDeleteModal(id, topic, cardCount) {
  pendingDeleteId = id;
  $('#delete-modal-text').textContent =
    `"${topic}" (${cardCount} cards) will be permanently removed from your saved decks.`;
  $('#delete-modal').classList.remove('hidden');
  $('#btn-delete-confirm').focus({ preventScroll: true });
}

function closeDeleteModal() {
  pendingDeleteId = null;
  $('#delete-modal').classList.add('hidden');
}

$('#btn-delete-cancel').addEventListener('click', closeDeleteModal);
$('#delete-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeDeleteModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#delete-modal').classList.contains('hidden')) {
    e.preventDefault();
    closeDeleteModal();
  }
});

$('#btn-delete-confirm').addEventListener('click', async () => {
  if (!pendingDeleteId) return;
  const btn = $('#btn-delete-confirm');
  btn.disabled = true;
  try {
    await api(`/api/decks/${pendingDeleteId}`, undefined, 'DELETE');
    closeDeleteModal();
    refreshSavedDecks();
  } catch (err) {
    $('#delete-modal-text').textContent = `Delete failed: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

// ---------- boot ----------
refreshSavedDecks();
api('/api/health').then(h => {
  $('#endpoint-label').textContent = h.endpoint.baseUrl;
}).catch(() => {
  $('#endpoint-label').textContent = 'LLM endpoint unknown';
});
