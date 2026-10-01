import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chatJson, transcribeImage, describeEndpoint, log } from './llm.js';
import { generateSystem, VERIFY_SYSTEM, FOLLOWUP_SYSTEM, CARD_COUNT, MIN_CARDS, MAX_CARDS } from './prompts.js';
import { saveDeck, listDecks, getDeck, deleteDeck } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const MAX_UPLOAD = process.env.MAX_UPLOAD || '10mb';

app.use(express.json({ limit: MAX_UPLOAD }));
app.use(express.static(path.join(__dirname, '..', 'web'), {
  etag: true,
  lastModified: true,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

function cleanCards(obj) {
  if (!obj || !Array.isArray(obj.cards)) throw new Error('LLM returned no cards array');
  const cards = obj.cards
    .filter(c => c && typeof c.question === 'string' && typeof c.answer === 'string')
    .map((c, i) => ({ id: i + 1, question: c.question.trim(), answer: c.answer.trim() }))
    .filter(c => c.question && c.answer);
  if (!cards.length) throw new Error('LLM returned no usable cards');
  return { topic: String(obj.topic || 'Study Deck').trim(), cards };
}

function sseInit(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

function sseSend(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function parseCardCount(count) {
  if (count === undefined || count === null || count === '') return CARD_COUNT;
  const n = parseInt(count, 10);
  if (!Number.isFinite(n)) return null;
  return Math.min(MAX_CARDS, Math.max(MIN_CARDS, n));
}

async function generateDeckCore(guide, cardCount, onCards) {
  const t0 = Date.now();
  const draft = cleanCards(await chatJson(generateSystem(cardCount), `Study guide text:\n"""\n${guide}\n"""`, { label: 'generate', onCards }));
  log(`api generate: draft has ${draft.cards.length} cards ("${draft.topic}") in ${Date.now() - t0}ms`);
  return draft;
}

async function verifyDeckCore(guide, deck, onChecked) {
  const t0 = Date.now();
  const verified = cleanCards(await chatJson(
    VERIFY_SYSTEM,
    `Original study guide text:\n"""\n${guide}\n"""\n\nFlashcards to verify:\n${JSON.stringify(deck, null, 2)}`,
    { label: 'verify', onCards: onChecked }
  ));
  log(`api verify: verified deck has ${verified.cards.length} cards in ${Date.now() - t0}ms (${verified.cards.length - deck.cards.length} removed)`);
  return verified;
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, endpoint: describeEndpoint() });
});

// Transcribe a photo of a study guide (vision model).
app.post('/api/transcribe', async (req, res) => {
  try {
    const { image } = req.body || {};
    if (!image || typeof image !== 'string') {
      return res.status(400).json({ error: 'Expected { image: "<base64>" }' });
    }
    const match = image.match(/^data:(image\/[a-zA-Z+]+);base64,/);
    const mime = match ? match[1] : 'image/jpeg';
    const b64 = match ? image.slice(match[0].length) : image;
    log(`api transcribe: received image (${mime}, ~${Math.round(b64.length / 1024)} KB base64)`);
    const t0 = Date.now();
    const text = await transcribeImage(b64, mime);
    log(`api transcribe: got ${text.trim().length} chars in ${Date.now() - t0}ms`);
    res.json({ text: text.trim() });
  } catch (err) {
    console.error('transcribe error:', err);
    res.status(502).json({ error: `Could not transcribe image: ${err.message}` });
  }
});

// Generate a draft flashcard deck from study guide text (verify is a separate call).
app.post('/api/generate', async (req, res) => {
  try {
    const { text, count } = req.body || {};
    if (!text || typeof text !== 'string' || text.trim().length < 20) {
      return res.status(400).json({ error: 'Study guide text is too short to work with.' });
    }
    const cardCount = parseCardCount(count);
    if (cardCount === null) {
      return res.status(400).json({ error: 'Card count must be a number.' });
    }
    const guide = text.trim();
    log(`api generate: guide is ${guide.length} chars, requesting ${cardCount} cards`);
    const draft = await generateDeckCore(guide, cardCount);
    res.json(draft);
  } catch (err) {
    console.error('generate error:', err);
    res.status(502).json({ error: `Could not generate flashcards: ${err.message}` });
  }
});

// Same as /api/generate but streams live card-count progress via SSE.
app.post('/api/generate/stream', async (req, res) => {
  const { text, count } = req.body || {};
  if (!text || typeof text !== 'string' || text.trim().length < 20) {
    return res.status(400).json({ error: 'Study guide text is too short to work with.' });
  }
  const cardCount = parseCardCount(count);
  if (cardCount === null) {
    return res.status(400).json({ error: 'Card count must be a number.' });
  }
  const guide = text.trim();
  sseInit(res);
  log(`api generate/stream: guide is ${guide.length} chars, requesting ${cardCount} cards`);
  try {
    const draft = await generateDeckCore(guide, cardCount, (n) => {
      log(`api generate/stream: wrote ${n}/${cardCount} cards`);
      sseSend(res, 'progress', { created: n, total: cardCount });
    });
    sseSend(res, 'done', draft);
  } catch (err) {
    console.error('generate/stream error:', err);
    sseSend(res, 'error', { error: `Could not generate flashcards: ${err.message}` });
  }
  res.end();
});

// Verify a draft deck against the original study guide.
app.post('/api/verify', async (req, res) => {
  try {
    const { text, deck } = req.body || {};
    if (!text || !deck || !Array.isArray(deck.cards) || !deck.cards.length) {
      return res.status(400).json({ error: 'Expected { text, deck: { topic, cards } }' });
    }
    log(`api verify: verifying ${deck.cards.length} cards against ${String(text).trim().length} chars of guide`);
    const verified = await verifyDeckCore(String(text).trim(), deck);
    res.json(verified);
  } catch (err) {
    console.error('verify error:', err);
    res.status(502).json({ error: `Could not verify flashcards: ${err.message}` });
  }
});

// Same as /api/verify but streams live checked-count progress via SSE.
app.post('/api/verify/stream', async (req, res) => {
  const { text, deck } = req.body || {};
  if (!text || !deck || !Array.isArray(deck.cards) || !deck.cards.length) {
    return res.status(400).json({ error: 'Expected { text, deck: { topic, cards } }' });
  }
  const total = deck.cards.length;
  sseInit(res);
  log(`api verify/stream: verifying ${total} cards against ${String(text).trim().length} chars of guide`);
  try {
    const verified = await verifyDeckCore(String(text).trim(), deck, (n) => {
      log(`api verify/stream: checked ${Math.min(n, total)}/${total} cards`);
      sseSend(res, 'progress', { checked: Math.min(n, total), total });
    });
    sseSend(res, 'done', verified);
  } catch (err) {
    console.error('verify/stream error:', err);
    sseSend(res, 'error', { error: `Could not verify flashcards: ${err.message}` });
  }
  res.end();
});

// Fresh follow-up questions on missed concepts.
app.post('/api/followup', async (req, res) => {
  try {
    const { text, missed } = req.body || {};
    if (!text || !Array.isArray(missed) || !missed.length) {
      return res.status(400).json({ error: 'Expected { text, missed: [{question, answer}] }' });
    }
    const slimMissed = missed.map(c => ({ question: c.question, answer: c.answer }));
    const t0 = Date.now();
    log(`api followup: ${slimMissed.length} missed concepts, generating fresh angles`);
    const deck = cleanCards(await chatJson(
      FOLLOWUP_SYSTEM,
      `Original study guide text:\n"""\n${String(text).trim()}\n"""\n\nCards the student missed:\n${JSON.stringify(slimMissed, null, 2)}`,
      { label: 'followup' }
    ));
    log(`api followup: generated ${deck.cards.length} cards in ${Date.now() - t0}ms`);
    res.json(deck);
  } catch (err) {
    console.error('followup error:', err);
    res.status(502).json({ error: `Could not generate follow-up cards: ${err.message}` });
  }
});

// Saved decks (simple JSON file storage) so expensive generations can be reused.
app.post('/api/decks', (req, res) => {
  try {
    const { topic, cards, guideText } = req.body || {};
    if (!Array.isArray(cards) || !cards.length) {
      return res.status(400).json({ error: 'Expected { topic, cards: [{question, answer}], guideText }' });
    }
    const deck = saveDeck({ topic, cards, guideText });
    log(`api decks: saved "${deck.topic}" (${deck.cards.length} cards) as ${deck.id}`);
    res.json({ id: deck.id });
  } catch (err) {
    console.error('deck save error:', err);
    res.status(500).json({ error: `Could not save deck: ${err.message}` });
  }
});

app.get('/api/decks', (req, res) => {
  res.json({ decks: listDecks() });
});

app.get('/api/decks/:id', (req, res) => {
  const deck = getDeck(req.params.id);
  if (!deck) return res.status(404).json({ error: 'Deck not found.' });
  res.json(deck);
});

app.delete('/api/decks/:id', (req, res) => {
  if (deleteDeck(req.params.id)) {
    log(`api decks: deleted ${req.params.id}`);
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: 'Deck not found.' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  const { baseUrl, model, visionModel } = describeEndpoint();
  console.log(`Flashcard Studio listening on http://0.0.0.0:${PORT}`);
  console.log(`LLM endpoint: ${baseUrl} (model: ${model}, vision model: ${visionModel})`);
});
