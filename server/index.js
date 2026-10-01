import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chatJson, transcribeImage, describeEndpoint } from './llm.js';
import { GENERATE_SYSTEM, VERIFY_SYSTEM, FOLLOWUP_SYSTEM } from './prompts.js';

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
    const text = await transcribeImage(b64, mime);
    res.json({ text: text.trim() });
  } catch (err) {
    console.error('transcribe error:', err);
    res.status(502).json({ error: `Could not transcribe image: ${err.message}` });
  }
});

// Generate + verify a flashcard deck from study guide text.
app.post('/api/generate', async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text || typeof text !== 'string' || text.trim().length < 20) {
      return res.status(400).json({ error: 'Study guide text is too short to work with.' });
    }
    const guide = text.trim();
    const draft = cleanCards(await chatJson(GENERATE_SYSTEM, `Study guide text:\n"""\n${guide}\n"""`));
    let deck = draft;
    try {
      deck = cleanCards(await chatJson(
        VERIFY_SYSTEM,
        `Original study guide text:\n"""\n${guide}\n"""\n\nFlashcards to verify:\n${JSON.stringify(draft, null, 2)}`
      ));
    } catch (err) {
      console.warn('verification pass failed, using unverified draft:', err.message);
    }
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
    const deck = cleanCards(await chatJson(
      FOLLOWUP_SYSTEM,
      `Original study guide text:\n"""\n${String(text).trim()}\n"""\n\nCards the student missed:\n${JSON.stringify(slimMissed, null, 2)}`
    ));
    res.json(deck);
  } catch (err) {
    console.error('followup error:', err);
    res.status(502).json({ error: `Could not generate follow-up cards: ${err.message}` });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  const { baseUrl, model, visionModel } = describeEndpoint();
  console.log(`Flashcard Studio listening on http://0.0.0.0:${PORT}`);
  console.log(`LLM endpoint: ${baseUrl} (model: ${model}, vision model: ${visionModel})`);
});
