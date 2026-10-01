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

## Saved decks

Because deck generation uses an expensive LLM, every finished deck is
**automatically saved** to a plain JSON file (`data/decks.json` on the server —
no database). When you return to the app, the upload screen lists your saved
decks; pick one to review it instantly with **zero LLM cost**. Saved decks keep
their original guide text, so follow-up rounds still work on them too.

- Storage location: `data/decks.json` (override the directory with `DECKS_DIR`)
- In Docker, this lives in the `flashcard-data` volume so it survives
  container rebuilds/pulls.

## Setup

Requires Docker (or Node >= 20.6).

```bash
cp .env.example .env
```

Edit `.env`:

```env
LLM_BASE_URL=http://basement.tail7452e.ts.net:8189/v1   # your OpenAI-compatible endpoint
LLM_MODEL=your-chat-model
VISION_MODEL=your-vision-model   # needed for photo uploads; defaults to LLM_MODEL
CARD_COUNT=15
# PORT=3000            # HTTP port (default 3000)
# DECKS_DIR=/app/data  # where saved decks are stored (default: ./data)
```

Run it:

```bash
docker compose up -d --build
```

Open `http://<your-machine>:3000` from any device on your LAN (phone, tablet,
your daughter's laptop).

Without Docker: `npm install && npm start`.

## Running the prebuilt container (remote hosts)

Every push to `main` (and every `v*` tag) is built by GitHub Actions and
published to the **GitHub Container Registry** for `linux/amd64` and
`linux/arm64` — so any remote box (home server, Pi, VM) can pull and run it
without building:

```bash
# if the package is private, log in first with a PAT that has read:packages
docker login ghcr.io -u <your-github-username>

docker pull ghcr.io/petecheslock/ai-study-guide:latest

docker run -d --name flashcards \
  -p 3000:3000 \
  --env-file .env \
  -v flashcard-data:/app/data \
  --restart unless-stopped \
  ghcr.io/petecheslock/ai-study-guide:latest
```

Or with a compose file on the remote host:

```yaml
services:
  flashcards:
    image: ghcr.io/petecheslock/ai-study-guide:latest
    ports:
      - "3000:3000"
    env_file: .env
    volumes:
      - flashcard-data:/app/data
    restart: unless-stopped

volumes:
  flashcard-data:
```

To upgrade later: `docker compose pull && docker compose up -d` — saved decks
persist in the volume.

### Image tags

| Tag | Meaning |
|---|---|
| `latest` | newest build from `main` |
| `sha-<shortsha>` | build of a specific commit |
| `1.2.3` / `1.2` | published from git tags `v1.2.3` etc. |

Make the GHCR package **public** (Package settings → Change visibility) if you
want hosts to pull it without logging in.

## API

| Endpoint | Method | Body | Returns |
|---|---|---|---|
| `/api/health` | GET | – | `{ ok, endpoint: { baseUrl, model, visionModel } }` |
| `/api/transcribe` | POST | `{ image }` (base64 or data-URL) | `{ text }` |
| `/api/generate` | POST | `{ text, count? }` (5–50) | `{ topic, cards }` |
| `/api/followup` | POST | `{ text, missed: [{question, answer}] }` | `{ topic, cards }` |
| `/api/decks` | POST | `{ topic, cards, guideText }` | `{ id }` |
| `/api/decks` | GET | – | `{ decks: [{ id, topic, cardCount, createdAt }] }` |
| `/api/decks/:id` | GET | – | full saved deck |

All errors return `{ error: "message" }` with 4xx/5xx status.

## Project layout

```
server/     Express API + LLM client + prompts + JSON deck store
web/        Static frontend (vanilla JS, no build step)
data/       Saved decks (JSON, gitignored; a Docker volume in containers)
.github/    CI: builds and publishes the container image to GHCR
AGENTS.md   Instructions for AI agents modifying this project
```

## Notes

- The endpoint must be **OpenAI-compatible** (`/chat/completions`): Ollama,
  LM Studio, llama.cpp server, vLLM, etc.
- Photo upload requires a **vision-capable** model (set `VISION_MODEL`).
- If the LLM is slow, that's the model — the UI shows progress steps.
- The container runs as the unprivileged `node` user; only `/app/data` needs
  to be writable.
