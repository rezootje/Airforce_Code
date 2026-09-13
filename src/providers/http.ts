import { setTimeout as delay } from 'node:timers/promises';
import { AirforceError } from '../utils/errors.js';

function abortFailure(signal?: AbortSignal): unknown {
  if (!signal?.aborted) return undefined;
  if ((signal.reason as { name?: string } | undefined)?.name === 'TimeoutError')
    return new AirforceError(
      'API request timed out. Retry the request or run airforce doctor.',
      'API_TIMEOUT',
    );
  return signal.reason;
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      reader.read().catch((error) => Promise.reject(abortFailure(signal) ?? error)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new AirforceError(
                `API stream produced no data for ${Math.round(idleTimeoutMs / 1000)} seconds. Retry or press Escape to cancel.`,
                'STREAM_TIMEOUT',
              ),
            ),
          idleTimeoutMs,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export function endpoint(base: string, path: string): string {
  return `${base.replace(/\/$/, '').replace(/\/v1$/, '')}/v1/${path}`;
}
export async function request(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const abortedBeforeRequest = abortFailure(signal);
    if (abortedBeforeRequest) throw abortedBeforeRequest;
    let response: Response;
    try {
      response = await fetch(url, { ...init, redirect: 'error', signal });
    } catch (e) {
      const aborted = abortFailure(signal);
      if (aborted) throw aborted;
      throw new AirforceError(
        `Cannot reach API. Check base URL, TLS and connectivity. ${e instanceof Error ? e.message : ''}`,
        'NETWORK',
      );
    }
    if (response.ok) return response;
    const status = response.status;
    await response.body?.cancel();
    if ([429, 502, 503, 504].includes(status) && attempt < 2) {
      const retry = Number(response.headers.get('retry-after'));
      await delay(Math.min(10000, retry > 0 ? retry * 1000 : 500 * 2 ** attempt), undefined, {
        signal,
      });
      continue;
    }
    const help =
      status === 401 || status === 403
        ? 'Check API key and endpoint access.'
        : status === 429
          ? 'Rate limited. Retry later.'
          : status === 404
            ? 'Check endpoint and selected model.'
            : status === 400
              ? 'Check model tool support, parameters and context limit.'
              : 'Try again or run airforce doctor.';
    throw new AirforceError(`API HTTP ${status}. ${help}`, `HTTP_${status}`);
  }
}
export async function boundedText(
  response: Response,
  max = 4_000_000,
  idleTimeoutMs = 30000,
  signal?: AbortSignal,
): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await readChunk(reader, idleTimeoutMs, signal);
      if (done) break;
      bytes += value.length;
      if (bytes > max) throw new AirforceError('API response exceeds size limit', 'RESPONSE_LIMIT');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
export async function* sse(
  response: Response,
  options: { idleTimeoutMs?: number; signal?: AbortSignal } = {},
): AsyncGenerator<unknown> {
  if (!response.body) throw new AirforceError('API returned no response body', 'PROTOCOL');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let total = 0;
  let data: string[] = [];
  function parse(): unknown {
    const raw = data.join('\n');
    data = [];
    if (!raw || raw === '[DONE]') return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      throw new AirforceError('Malformed SSE JSON from API', 'PROTOCOL');
    }
  }
  try {
    while (true) {
      const { value, done } = await readChunk(
        reader,
        options.idleTimeoutMs ?? 60000,
        options.signal,
      );
      if (done) {
        buffer += decoder.decode();
        break;
      }
      total += value.length;
      if (total > 16_000_000)
        throw new AirforceError('API stream exceeds response limit', 'RESPONSE_LIMIT');
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 2_000_000)
        throw new AirforceError('SSE frame exceeds size limit', 'RESPONSE_LIMIT');
      let pos: number;
      while ((pos = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, pos).replace(/\r$/, '');
        buffer = buffer.slice(pos + 1);
        if (!line) {
          const event = parse();
          if (event !== undefined) yield event;
        } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
    }
    if (buffer.startsWith('data:')) data.push(buffer.slice(5).trimStart());
    if (data.length) {
      const event = parse();
      if (event !== undefined) yield event;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
