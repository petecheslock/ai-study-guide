import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DECKS_DIR || path.join(__dirname, '..', 'data');
const DECKS_FILE = path.join(DATA_DIR, 'decks.json');

function loadAll() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DECKS_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveAll(decks) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DECKS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(decks, null, 2));
  fs.renameSync(tmp, DECKS_FILE);
}

export function saveDeck({ topic, cards, guideText }) {
  const decks = loadAll();
  const deck = {
    id: Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
    topic: String(topic || 'Study Deck').trim(),
    cards,
    guideText: String(guideText || ''),
    createdAt: new Date().toISOString(),
  };
  decks.unshift(deck);
  saveAll(decks);
  return deck;
}

export function listDecks() {
  return loadAll().map(({ id, topic, cards, createdAt }) => ({
    id,
    topic,
    cardCount: Array.isArray(cards) ? cards.length : 0,
    createdAt,
  }));
}

export function getDeck(id) {
  return loadAll().find((d) => d.id === id) || null;
}
