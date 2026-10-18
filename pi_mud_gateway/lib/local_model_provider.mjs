import { parseJsonObject } from './high_level_decider.mjs';

function checkedConfig(config) {
  if (!['ollama', 'gateway'].includes(config.provider)) throw new Error('decision provider must be ollama or gateway');
  if (typeof config.model !== 'string' || !config.model.trim()) throw new Error('decision model must be configured explicitly');
  const endpoint = new URL(config.endpoint);
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('decision endpoint must use http or https');
  return { ...config, endpoint, timeoutMs: Math.min(Math.max(config.timeoutMs ?? 15_000, 1000), 60_000) };
}

async function postJson(url, body, timeoutMs, fetchImpl, headers = {}) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`decision provider HTTP ${response.status}`);
  return response.json();
}

export function createLocalModelProvider(input, { fetchImpl = fetch } = {}) {
  const config = checkedConfig(input);
  return {
    async completeJson(prompt) {
      if (config.provider === 'ollama') {
        const url = new URL('/api/chat', config.endpoint);
        const data = await postJson(url, {
          model: config.model,
          stream: false,
          format: 'json',
          messages: [{ role: 'user', content: prompt }],
          options: { temperature: 0 },
        }, config.timeoutMs, fetchImpl);
        return parseJsonObject(data?.message?.content);
      }
      const url = new URL('/v1/chat/completions', config.endpoint);
      const headers = config.apiKeyEnv && process.env[config.apiKeyEnv]
        ? { authorization: `Bearer ${process.env[config.apiKeyEnv]}` }
        : {};
      const data = await postJson(url, {
        model: config.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: prompt }],
      }, config.timeoutMs, fetchImpl, headers);
      return parseJsonObject(data?.choices?.[0]?.message?.content);
    },
  };
}
