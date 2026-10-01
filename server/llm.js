// Thin client for any OpenAI-compatible chat completions endpoint.

const BASE_URL = (process.env.LLM_BASE_URL || 'http://localhost:11434/v1').replace(/\/+$/, '');
const MODEL = process.env.LLM_MODEL || 'llama3';
const VISION_MODEL = process.env.VISION_MODEL || MODEL;
const API_KEY = process.env.LLM_API_KEY || '';

export function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

async function chat(messages, { model, temperature = 0.3, maxRetries = 2, label = 'chat', onDelta } = {}) {
  const body = {
    model: model || MODEL,
    messages,
    temperature,
    stream: !!onDelta
  };
  if (onDelta) body.stream_options = { include_usage: true };
  const headers = { 'Content-Type': 'application/json' };
  if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`;

  const approxChars = messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length), 0);
  log(`llm ${label}: sending request model=${body.model} messages=${messages.length} ~${approxChars} chars${onDelta ? ' (streaming)' : ''}`);

  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const t0 = Date.now();
    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`LLM endpoint returned ${res.status}: ${text.slice(0, 500)}`);
      }
      let content;
      let usage = {};
      if (onDelta) {
        content = '';
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') continue;
            try {
              const j = JSON.parse(payload);
              if (j.usage) usage = j.usage;
              const delta = j.choices?.[0]?.delta?.content || '';
              if (delta) {
                content += delta;
                onDelta(delta, content);
              }
            } catch { /* ignore malformed keepalive chunks */ }
          }
        }
      } else {
        const data = await res.json();
        content = data?.choices?.[0]?.message?.content;
        usage = data.usage || {};
      }
      if (!content) throw new Error('LLM response had no content');
      log(`llm ${label}: ok in ${Date.now() - t0}ms (attempt ${attempt + 1}) tokens: prompt=${usage.prompt_tokens ?? '?'} completion=${usage.completion_tokens ?? '?'} total=${usage.total_tokens ?? '?'}`);
      return content;
    } catch (err) {
      lastErr = err;
      log(`llm ${label}: attempt ${attempt + 1}/${maxRetries + 1} failed after ${Date.now() - t0}ms: ${err.message}`);
      if (attempt < maxRetries) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

// Extract a JSON object from an LLM reply (handles code fences / preamble text).
export function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('No JSON object found in LLM response');
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

// Incrementally counts completed card objects inside the `"cards": [ ... ]` array
// of a partially streamed JSON document. Feed it the growing text; it returns the
// count of fully closed card objects so far. All parser state persists across
// feeds so arbitrary chunk boundaries are safe. Final parse is authoritative —
// this is only for live progress display.
export function createCardCounter() {
  let consumed = 0;
  let inCards = false;
  let cardsKeySeen = false;
  let inString = false;
  let escape = false;
  let stringContent = '';
  let depth = 0;
  let count = 0;

  return function feed(text) {
    for (let i = consumed; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escape) { stringContent += ch; escape = false; }
        else if (ch === '\\') escape = true;
        else if (ch === '"') {
          inString = false;
          if (!inCards && stringContent === 'cards') cardsKeySeen = true;
        } else stringContent += ch;
        continue;
      }
      if (inCards) {
        if (ch === '"') inString = true;
        else if (ch === '[') depth++;
        else if (ch === '{') depth++;
        else if (ch === ']') depth--;
        else if (ch === '}') {
          depth--;
          if (depth === 1) count++;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
        stringContent = '';
      } else if (cardsKeySeen && ch === '[') {
        inCards = true;
        cardsKeySeen = false;
        depth = 1;
      }
    }
    consumed = text.length;
    return count;
  };
}

// Ask the LLM for a JSON object; retry with a correction nudge if unparseable.
// opts.onCards(count) receives live progress of completed cards while streaming.
export async function chatJson(systemPrompt, userContent, opts = {}) {
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent }
  ];
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    let onDelta;
    if (opts.onCards) {
      const counter = createCardCounter();
      let lastCount = 0;
      onDelta = (_delta, full) => {
        const n = counter(full);
        if (n > lastCount) {
          lastCount = n;
          opts.onCards(n);
        }
      };
    }
    const raw = await chat(messages, { ...opts, onDelta });
    try {
      return extractJson(raw);
    } catch (err) {
      lastErr = err;
      log(`llm ${opts.label || 'chat'}: unparseable JSON (${err.message}), retrying with correction nudge`);
      messages.push({ role: 'assistant', content: raw });
      messages.push({
        role: 'user',
        content: 'That was not valid JSON. Respond again with ONLY the JSON object, no prose, no markdown fences.'
      });
    }
  }
  throw lastErr;
}

export async function transcribeImage(imageBase64, mimeType) {
  return chat(
    [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Transcribe ALL text visible in this image of a study guide, verbatim, preserving structure (headings, numbered items, questions, tables as plain text). Output only the transcription.'
          },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } }
        ]
      }
    ],
    { model: VISION_MODEL, temperature: 0.1 }
  );
}

export function describeEndpoint() {
  return { baseUrl: BASE_URL, model: MODEL, visionModel: VISION_MODEL };
}
