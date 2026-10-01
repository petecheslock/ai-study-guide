# Flashcard Studio

Turn any study guide — pasted text or a photo — into interactive flashcards,
powered entirely by your **local LLM**. Nothing leaves your home network.

![flow](https://img.shields.io/badge/flow-upload%20→%20study%20→%20follow--up-orange)

## How it works

1. **Upload** a study guide (paste text, or drop/take a photo — a vision model transcribes it).
2. **Generate** — the LLM writes a flashcard deck from the guide, then a second
   pass fact-checks every card against the original text and fixes or drops
   anything unsupported.
3. **Study** — see the question, think, flip the card (tap or `space`):
   - **→** (or green button) = *I got it*
   - **←** (or red button) = *still fuzzy*
4. **Follow-up** — when the round ends, the concepts you missed go back to the
   LLM, which writes a **brand-new set of questions** on just those concepts
   (different angle, same material). Repeat until nothing is missed.

Nothing is stored — decks live only in the browser session.

## Setup

Requires Docker (or Node >= 18).

```bash
cp .env.example .env
```

Edit `.env`:

```env
LLM_BASE_URL=http://basement.tail7452e.ts.net:8189/v1   # your OpenAI-compatible endpoint
LLM_MODEL=your-chat-model
VISION_MODEL=your-vision-model   # needed for photo uploads; defaults to LLM_MODEL
CARD_COUNT=15
```

Run it:

```bash
docker compose up -d --build
```

Open `http://<your-machine>:3000` from any device on your LAN (phone, tablet,
your daughter's laptop).

Without Docker: `npm install && npm start`.

## Project layout

```
server/     Express API + LLM client + prompts
web/        Static frontend (vanilla JS, no build step)
AGENTS.md   Instructions for AI agents modifying this project
```

## Notes

- The endpoint must be **OpenAI-compatible** (`/chat/completions`): Ollama,
  LM Studio, llama.cpp server, vLLM, etc.
- Photo upload requires a **vision-capable** model (set `VISION_MODEL`).
- If the LLM is slow, that's the model — the UI shows progress steps.
