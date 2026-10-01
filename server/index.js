import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chatJson, transcribeImage, describeEndpoint, log } from './llm.js';
import { generateSystem, VERIFY_SYSTEM, FOLLOWUP_SYSTEM, CARD_COUNT, MIN_CARDS, MAX_CARDS } from './prompts.js';
import { saveDeck, listDecks, getDeck } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const MAX_UPLOAD = process.env.MAX_UPLOAD || '10mb';

app.use(express.json({ limit: MAX_UPLOAD }));
app.use(express.static(path.join(__dirname, '..', 'web')));

function cleanCards(obj) {
  if (!obj || !Array.isArray(obj.cards)) throw new Error('LLM returned no cards array');
  const cards = obj.cards
    .filter(c => c && typeof c.question === 'string' && typeof c.answer === 'string')
    .map((c, i) => ({ id: i + 1, question: c.question.trim(), answer: c.answer.trim() }))
    .filter(c => c.question && c.answer);
  if (!cards.length) throw new Error('LLM returned no usable cards');
  return { topic: String(obj.topic || 'Study Deck').trim(), cards };
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

// Generate + verify a flashcard deck from study guide text.
app.post('/api/generate', async (req, res) => {
  try {
    const { text, count } = req.body || {};
    if (!text || typeof text !== 'string' || text.trim().length < 20) {
      return res.status(400).json({ error: 'Study guide text is too short to work with.' });
    }
    let cardCount = CARD_COUNT;
    if (count !== undefined && count !== null && count !== '') {
      const n = parseInt(count, 10);
      if (!Number.isFinite(n)) {
        return res.status(400).json({ error: 'Card count must be a number.' });
      }
      cardCount = Math.min(MAX_CARDS, Math.max(MIN_CARDS, n));
    }
    const guide = text.trim();
    const t0 = Date.now();
    log(`api generate: guide is ${guide.length} chars, requesting ${cardCount} cards`);
    const draft = cleanCards(await chatJson(generateSystem(cardCount), `Study guide text:\n"""\n${guide}\n"""`, { label: 'generate' }));
    log(`api generate: draft has ${draft.cards.length} cards ("${draft.topic}") in ${Date.now() - t0}ms`);
    let deck = draft;
    const tVerify = Date.now();
    try {
      deck = cleanCards(await chatJson(
        VERIFY_SYSTEM,
        `Original study guide text:\n"""\n${guide}\n"""\n\nFlashcards to verify:\n${JSON.stringify(draft, null, 2)}`,
        { label: 'verify' }
      ));
      log(`api generate: verified deck has ${deck.cards.length} cards in ${Date.now() - tVerify}ms (${deck.cards.length - draft.cards.length} removed)`);
    } catch (err) {
      console.warn('verification pass failed, using unverified draft:', err.message);
    }
    log(`api generate: done in ${Date.now() - t0}ms total`);
    res.json(deck);
  } catch (err) {
    console.error('generate error:', err);
    res.status(502).json({ error: `Could not generate flashcards: ${err.message}` });
  }
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

app.listen(PORT, '0.0.0.0', () => {
  const { baseUrl, model, visionModel } = describeEndpoint();
  console.log(`Flashcard Studio listening on http://0.0.0.0:${PORT}`);
  console.log(`LLM endpoint: ${baseUrl} (model: ${model}, vision model: ${visionModel})`);
});
