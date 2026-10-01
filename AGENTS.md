# AGENTS.md — Flashcard Studio

Instructions for AI agents (opencode, Copilot, etc.) working on this project.

## What this is

A self-hosted, LAN-only web app that turns a study guide (pasted text or a photo)
into interactive flashcards using a **local, OpenAI-compatible LLM endpoint**.
A student studies with ← / → arrow keys (don't know / got it); after each round,
missed concepts are sent back to the LLM to generate a **fresh follow-up deck**
on just those concepts.

**Deck persistence (owner-requested).** Generated decks are saved to a plain
JSON file (`data/decks.json`) so expensive LLM generations can be reviewed
later. Do not add a database.

## Architecture

```
web/            Static frontend (vanilla HTML/CSS/JS, no build step)
  index.html    Screens: upload → loading → study → round-complete
  app.js        Client state machine + fetch calls to the API
  styles.css    "Warm night-light" theme (Fraunces + Nunito)
server/
  index.js      Express app: static files + JSON API
  llm.js        OpenAI-compatible chat client (fetch, retries, JSON extraction)
  prompts.js    System prompts: generate, verify, follow-up
  store.js      Saved-deck storage (JSON file at data/decks.json)
data/
  decks.json    Saved decks (gitignored)
```

## API contract

| Endpoint | Method | Body | Returns |
|---|---|---|---|
| `/api/health` | GET | – | `{ ok, endpoint: { baseUrl, model, visionModel } }` |
| `/api/transcribe` | POST | `{ image: "<base64 or data-URL>" }` | `{ text }` (vision model transcription) |
| `/api/generate` | POST | `{ text, count? }` (count 5–50, clamped; defaults to `CARD_COUNT`) | `{ topic, cards: [{ id, question, answer }] }` |
| `/api/followup` | POST | `{ text, missed: [{ question, answer }] }` | `{ topic, cards: [...] }` |
| `/api/decks` | POST | `{ topic, cards, guideText }` | `{ id }` (saves deck to JSON file) |
| `/api/decks` | GET | – | `{ decks: [{ id, topic, cardCount, createdAt }] }` |
| `/api/decks/:id` | GET | – | full saved deck `{ id, topic, cards, guideText, createdAt }` |
| `/api/decks/:id` | DELETE | – | `{ ok: true }` (404 if missing) |

All errors return `{ error: "message" }` with 4xx/5xx status.

## Key invariants — do not break

1. **Ground truth is the study guide.** All prompts forbid inventing facts.
   The verify pass (`VERIFY_SYSTEM`) corrects/removes unsupported cards.
2. **Follow-up cards test the same concepts from a NEW angle** — never a copy
   of the missed card. This is deliberate (tests understanding, not recall of
   the card itself).
3. **JSON robustness**: `extractJson()` in `llm.js` tolerates code fences and
   preamble; `chatJson()` retries once with a correction nudge. Keep this —
   local models are sloppy.
4. **Client-side study state.** The browser holds `guideText`, current cards,
   missed list, and round number, and sends them back on `/api/followup`.
   The server only persists finished decks via `store.js` (JSON file).
5. **Keyboard**: Space/Enter flips, ArrowRight = knew it, ArrowLeft = missed,
   Esc = end session (with confirm). Touch buttons mirror this. Keep both working.

## Configuration

All config via env vars (see `.env.example`):
- `LLM_BASE_URL` — OpenAI-compatible endpoint, e.g. `http://basement.tail7452e.ts.net:8189/v1`
- `LLM_MODEL` — chat model; `VISION_MODEL` — vision-capable model for photos (defaults to chat model)
- `CARD_COUNT` — cards per deck (default 15)
- `PORT` — HTTP port (default 3000)

## Running

```bash
cp .env.example .env   # edit endpoint + model
docker compose up -d   # serves on http://<host>:3000
# or without Docker:
npm install && npm start
```

## Conventions

- Node >= 20.6 (native fetch + `--env-file` for `.env` loading), ES modules only (`"type": "module"`).
- No frontend build tooling — keep it dependency-free vanilla JS.
- Only runtime dependency is `express`. Do not add more without need.
- Prompts live in `server/prompts.js` only — never inline them in routes.
