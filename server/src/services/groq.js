/**
 * Minimal Groq client (OpenAI-compatible chat completions) using Node's built-in fetch.
 * Backend-only: the API key is read from server config and never leaves this process.
 *
 * Every failure is mapped to a GroqError with a `kind` so the AI service can degrade
 * gracefully: NO_KEY | TIMEOUT | RATE_LIMIT | UNAVAILABLE | BAD_RESPONSE.
 */

export class GroqError extends Error {
  /** @param {'NO_KEY'|'TIMEOUT'|'RATE_LIMIT'|'UNAVAILABLE'|'BAD_RESPONSE'} kind */
  constructor(kind, message) {
    super(message);
    this.name = 'GroqError';
    this.kind = kind;
  }
}

/**
 * @param {{ apiKey: string, model: string, timeoutMs: number, baseUrl: string }} cfg
 * @param {typeof fetch} [fetchImpl] injectable for tests
 */
export function createGroqClient(cfg, fetchImpl = globalThis.fetch) {
  const enabled = Boolean(cfg.apiKey);

  /**
   * Request a JSON-object completion.
   * @param {Array<{ role: 'system'|'user', content: string }>} messages
   * @returns {Promise<{ content: string, latencyMs: number, model: string }>}
   */
  async function chatJson(messages) {
    if (!enabled) throw new GroqError('NO_KEY', 'GROQ_API_KEY is not configured');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    const started = Date.now();
    try {
      const res = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
          model: cfg.model,
          messages,
          temperature: 0.1,
          max_tokens: 1200,
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });

      if (res.status === 429) throw new GroqError('RATE_LIMIT', 'Groq rate limit reached');
      if (res.status >= 500) throw new GroqError('UNAVAILABLE', `Groq returned HTTP ${res.status}`);
      if (res.status === 401 || res.status === 403) throw new GroqError('UNAVAILABLE', 'Groq rejected the API key');
      if (!res.ok) throw new GroqError('BAD_RESPONSE', `Groq returned HTTP ${res.status}`);

      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) throw new GroqError('BAD_RESPONSE', 'Groq returned an empty completion');
      return { content, latencyMs: Date.now() - started, model: data.model || cfg.model };
    } catch (err) {
      if (err instanceof GroqError) throw err;
      if (err?.name === 'AbortError') throw new GroqError('TIMEOUT', `Groq did not answer within ${cfg.timeoutMs} ms`);
      throw new GroqError('UNAVAILABLE', 'Could not reach Groq');
    } finally {
      clearTimeout(timer);
    }
  }

  return { enabled, model: cfg.model, chatJson };
}
