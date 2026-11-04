// Thin fetch wrapper around Mistral chat completions (function calling + structured outputs).
const API = 'https://api.mistral.ai/v1/chat/completions';

export const MODELS = {
  agent: process.env.MISTRAL_AGENT_MODEL || 'mistral-medium-latest',
  parser: process.env.MISTRAL_PARSER_MODEL || 'mistral-small-latest',
};

export const hasKey = () => Boolean(process.env.MISTRAL_API_KEY);

export async function chat({ model = MODELS.agent, messages, tools, tool_choice, response_format, temperature = 0.2, max_tokens, timeoutMs = 60000 }) {
  if (!hasKey()) throw new Error('MISTRAL_API_KEY not set');
  const body = { model, messages, temperature };
  if (tools?.length) { body.tools = tools; body.tool_choice = tool_choice || 'auto'; }
  if (response_format) body.response_format = response_format;
  if (max_tokens) body.max_tokens = max_tokens;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.MISTRAL_API_KEY}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`Mistral HTTP ${res.status}`);
        await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
        continue;
      }
      if (!res.ok) throw new Error(`Mistral HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const json = await res.json();
      return json.choices?.[0]?.message || { role: 'assistant', content: '' };
    } catch (e) {
      lastErr = e;
      if (e.message?.startsWith('Mistral HTTP 4')) throw e;
    }
  }
  throw lastErr;
}

// Structured output: returns parsed JSON conforming to `schema`.
export async function structured({ model = MODELS.parser, system, user, name, schema, timeoutMs = 60000 }) {
  const msg = await chat({
    model,
    temperature: 0,
    timeoutMs,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: user },
    ],
    response_format: { type: 'json_schema', json_schema: { name, schema, strict: true } },
  });
  const text = typeof msg.content === 'string' ? msg.content : (msg.content || []).map(c => c.text || '').join('');
  return JSON.parse(text);
}
