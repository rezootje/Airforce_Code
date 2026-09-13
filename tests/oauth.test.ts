import { it, expect, vi, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { loginOAuth, listenForCode, pkce, revokeOAuth } from '../src/auth/oauth.js';
import { assertCredentials } from '../src/auth/credentials.js';
import { configSchema, FileAuthStore } from '../src/config/config.js';
import { AirforceProvider } from '../src/providers/airforce.js';
import { workspace } from './helpers.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AIRFORCE_API_URL,
  AIRFORCE_OAUTH_CLIENT_ID,
  AIRFORCE_OAUTH_REDIRECT_URI,
} from '../src/auth/constants.js';
afterEach(() => vi.unstubAllGlobals());
async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
it('generates cryptographic state and S256 PKCE', () => {
  const pair = pkce();
  expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(pair.challenge).toBe(createHash('sha256').update(pair.verifier).digest('base64url'));
  expect(pair.state).not.toBe(pkce().state);
});

it('uses the registered public-client defaults in one central configuration', () => {
  const config = configSchema.parse({});
  expect(config.baseUrl).toBe(AIRFORCE_API_URL);
  expect(config.oauthIssuer).toBe(AIRFORCE_API_URL);
  expect(config.oauthClientId).toBe(AIRFORCE_OAUTH_CLIENT_ID);
  expect(config.oauthRedirectUri).toBe(AIRFORCE_OAUTH_REDIRECT_URI);
  expect(config.oauthScopes).toEqual(['profile', 'chat']);
});
it('rejects forged state and callback paths, then accepts the valid code once', async () => {
  const controller = new AbortController();
  const listener = await listenForCode(
    'http://localhost:0/oauth/callback',
    'expected-state',
    controller.signal,
  );
  try {
    const wrong = new URL(listener.redirectUri);
    wrong.search = 'code=bad&state=wrong';
    expect((await fetch(wrong)).status).toBe(400);
    const outside = new URL('/wrong', listener.redirectUri);
    expect((await fetch(outside)).status).toBe(404);
    const right = new URL(listener.redirectUri);
    right.search = 'code=verified&state=expected-state';
    expect((await fetch(right)).status).toBe(200);
    expect(await listener.result).toBe('verified');
    expect((await fetch(right)).status).toBe(409);
  } finally {
    await listener.close();
  }
});
it('rejects duplicate parameters, invalid Host and non-GET requests', async () => {
  const listener = await listenForCode(
    'http://localhost:0/oauth/callback',
    'state',
    new AbortController().signal,
  );
  try {
    expect((await fetch(listener.redirectUri + '?code=bad&state=state&state=state')).status).toBe(
      400,
    );
    expect((await fetch(listener.redirectUri, { headers: { host: 'evil.example' } })).status).toBe(
      400,
    );
    expect((await fetch(listener.redirectUri, { method: 'POST' })).status).toBe(400);
  } finally {
    await listener.close();
  }
});
it('handles access denial and abort, closing the listener', async () => {
  const controller = new AbortController();
  const listener = await listenForCode(
    'http://localhost:0/oauth/callback',
    'state',
    controller.signal,
  );
  await fetch(listener.redirectUri + '?error=access_denied&state=state');
  await expect(listener.result).rejects.toThrow('declined');
  await listener.close();
  const second = await listenForCode(
    'http://localhost:0/oauth/callback',
    'state',
    controller.signal,
  );
  controller.abort(new Error('cancelled'));
  await expect(second.result).rejects.toThrow('cancelled');
  await second.close();
  await expect(fetch(second.redirectUri)).rejects.toThrow();
});
it('exchanges a public-client code without client_secret, validates profile, stores privately and revokes', async () => {
  const w = await workspace();
  let challenge = '';
  let expectedRedirect = '';
  let exchanged = 0;
  let revoked = 0;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const form = new URLSearchParams(raw);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/oauth/token') {
      exchanged++;
      expect(form.has('client_secret')).toBe(false);
      expect(req.headers.authorization).toBeUndefined();
      expect(form.get('client_id')).toBe('test-public-client');
      expect(form.get('redirect_uri')).toBe(expectedRedirect);
      expect(createHash('sha256').update(form.get('code_verifier')!).digest('base64url')).toBe(
        challenge,
      );
      res.end(
        JSON.stringify({
          access_token: 'airf_oat_synthetic_test_token',
          token_type: 'Bearer',
          expires_in: 86400,
          scope: 'profile chat',
        }),
      );
    } else if (req.url === '/oauth/userinfo') {
      expect(req.headers.authorization).toBe('Bearer airf_oat_synthetic_test_token');
      res.end('{"id":"test-user","username":"test"}');
    } else if (req.url === '/oauth/revoke') {
      revoked++;
      expect(form.get('token')).toBe('airf_oat_synthetic_test_token');
      res.end('{}');
    } else res.writeHead(404).end('{}');
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test address');
    const origin = `http://127.0.0.1:${address.port}`;
    const config = configSchema.parse({
      baseUrl: origin,
      oauthIssuer: origin,
      oauthClientId: 'test-public-client',
      oauthRedirectUri: `http://localhost:${await availablePort()}/oauth/callback`,
    });
    const credentials = await loginOAuth(
      config,
      async (url) => {
        const authorization = new URL(url);
        expect(authorization.pathname).toBe('/oauth/authorize');
        expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
        challenge = authorization.searchParams.get('code_challenge')!;
        expectedRedirect = authorization.searchParams.get('redirect_uri')!;
        const callback = new URL(expectedRedirect);
        callback.search = new URLSearchParams({
          code: 'one-time-code',
          state: authorization.searchParams.get('state')!,
        }).toString();
        await fetch(callback);
      },
      new AbortController().signal,
    );
    expect(exchanged).toBe(1);
    expect(credentials.username).toBe('test');
    expect(credentials.expiresAt).toBeGreaterThan(Date.now() + 86000 * 1000);
    const store = new FileAuthStore(w.home);
    await store.save(credentials);
    expect(await store.load()).toEqual(credentials);
    await expect(readFile(join(w.home, 'config.json'))).rejects.toThrow();
    await revokeOAuth(credentials, new AbortController().signal);
    expect(revoked).toBe(1);
    await store.clear();
    expect(await store.load()).toBeUndefined();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await w.cleanup();
  }
}, 15000);
it('rejects expired credentials and origin changes before network requests', () => {
  const credentials = {
    kind: 'oauth' as const,
    accessToken: 'airf_oat_test',
    expiresAt: Date.now() - 1,
    issuer: 'https://api.airforce',
    scope: 'profile chat',
    clientId: 'test',
  };
  expect(() => assertCredentials(credentials, 'https://api.airforce')).toThrow('expired');
  expect(() =>
    assertCredentials({ ...credentials, expiresAt: Date.now() + 100000 }, 'https://other.example'),
  ).toThrow('different API origin');
});
it('uses Bearer OAuth credentials on the Anthropic endpoint', async () => {
  const mock = vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response(
        'data: {"type":"content_block_delta","delta":{"text":"ok"}}\n\ndata: {"type":"message_stop"}\n\n',
      ),
  );
  vi.stubGlobal('fetch', mock);
  const provider = new AirforceProvider(
    configSchema.parse({
      baseUrl: 'https://api.airforce',
      model: 'synthetic',
      protocol: 'anthropic',
    }),
    {
      kind: 'oauth',
      accessToken: 'airf_oat_synthetic',
      expiresAt: Date.now() + 100000,
      scope: 'profile chat',
      issuer: 'https://api.airforce',
      clientId: 'test',
    },
  );
  for await (const _event of provider.complete(
    [{ role: 'user', content: 'test' }],
    [],
    new AbortController().signal,
  )) {
    /* consume */
  }
  const headers = mock.mock.calls[0]?.[1].headers as Record<string, string>;
  expect(headers.authorization).toBe('Bearer airf_oat_synthetic');
  expect(headers['x-api-key']).toBeUndefined();
});
