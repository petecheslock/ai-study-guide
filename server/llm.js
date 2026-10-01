// Thin client for any OpenAI-compatible chat completions endpoint.

const BASE_URL = (process.env.LLM_BASE_URL || 'http://localhost:11434/v1').replace(/\/+$/, '');
const MODEL = process.env.LLM_MODEL || 'llama3';
const VISION_MODEL = process.env.VISION_MODEL || MODEL;
const API_KEY = process.env.LLM_API_KEY || '';

export function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

async function chat(messages, { model, temperature = 0.3, maxRetries = 2, label = 'chat' } = {}) {
  const body = {
    model: model || MODEL,
    messages,
    temperature,
    stream: false
  };
  const headers = { 'Content-Type': 'application/json' };
  if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`;

  const approxChars = messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length), 0);
  log(`llm ${label}: sending request model=${body.model} messages=${messages.length} ~${approxChars} chars`);

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
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new Error('LLM response had no content');
      const u = data.usage || {};
      log(`llm ${label}: ok in ${Date.now() - t0}ms (attempt ${attempt + 1}) tokens: prompt=${u.prompt_tokens ?? '?'} completion=${u.completion_tokens ?? '?'} total=${u.total_tokens ?? '?'}`);
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

// Ask the LLM for a JSON object; retry with a correction nudge if unparseable.
export async function chatJson(systemPrompt, userContent, opts = {}) {
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent }
  ];
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await chat(messages, opts);
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
