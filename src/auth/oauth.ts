import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Config } from '../config/config.js';
import type { OAuthCredentials } from './credentials.js';
import { AirforceError } from '../utils/errors.js';
import { boundedText, request } from '../providers/http.js';
export function pkce(): { verifier: string; challenge: string; state: string } {
  const verifier = randomBytes(32).toString('base64url');
  return {
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
    state: randomBytes(32).toString('base64url'),
  };
}
function equals(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export interface CallbackListener {
  redirectUri: string;
  result: Promise<string>;
  close(): Promise<void>;
}
export async function listenForCode(
  redirectUri: string,
  state: string,
  signal: AbortSignal,
): Promise<CallbackListener> {
  signal.throwIfAborted();
  const requested = new URL(redirectUri);
  if (
    requested.protocol !== 'http:' ||
    requested.hostname !== 'localhost' ||
    requested.pathname !== '/oauth/callback' ||
    requested.search ||
    requested.hash ||
    requested.username ||
    requested.password
  )
    throw new AirforceError(
      'OAuth redirect must be http://localhost:PORT/oauth/callback',
      'OAUTH_CONFIG',
      2,
    );
  const servers: Server[] = [];
  let callback = requested;
  let settled = false;
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: unknown) => void;
  const result = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // The caller may be opening a browser before awaiting result; avoid an unhandled early rejection.
  void result.catch(() => undefined);
  const fail = (error: unknown) => {
    if (!settled) {
      settled = true;
      rejectCode(error);
    }
  };
  const handle = (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-security-policy', "default-src 'none'");
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-content-type-options', 'nosniff');
    if (
      req.method !== 'GET' ||
      req.headers.host !== callback.host ||
      !req.url ||
      req.url.length > 10000
    ) {
      res.writeHead(400).end('Invalid callback request.');
      return;
    }
    const url = new URL(req.url, callback);
    if (url.origin !== callback.origin || url.pathname !== callback.pathname) {
      res.writeHead(404).end('Not found.');
      return;
    }
    if (settled) {
      res.writeHead(409).end('Authorization already received.');
      return;
    }
    if (
      url.searchParams.getAll('state').length !== 1 ||
      !equals(url.searchParams.get('state') ?? '', state)
    ) {
      res.writeHead(400).end('Invalid authorization state. Return to the original sign-in window.');
      return;
    }
    if (url.searchParams.has('error')) {
      res.writeHead(200).end('Authorization was declined. Return to Airforce.');
      fail(
        new AirforceError(
          'OAuth authorization was declined. No credentials were saved.',
          'AUTH_DENIED',
          2,
        ),
      );
      return;
    }
    const code = url.searchParams.get('code');
    if (!code || code.length > 4096 || url.searchParams.getAll('code').length !== 1) {
      res.writeHead(400).end('Missing or invalid authorization code.');
      return;
    }
    settled = true;
    res.end('Authorization received. Return to your Airforce terminal to finish signing in.');
    resolveCode(code);
  };
  const bind = async (host: string, port: number) => {
    const server = createServer(handle);
    server.requestTimeout = 10000;
    server.headersTimeout = 10000;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host, port, ipv6Only: host === '::1' }, () => {
        server.off('error', reject);
        server.on('error', fail);
        resolve();
      });
    });
    servers.push(server);
    return server;
  };
  const close = async () => {
    signal.removeEventListener('abort', abort);
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          }),
      ),
    );
  };
  const abort = () => {
    fail(signal.reason);
    void close();
  };
  try {
    const ipv4 = await bind('127.0.0.1', Number(requested.port) || 0);
    const address = ipv4.address();
    if (!address || typeof address === 'string') throw new Error('No callback listener address');
    callback = new URL(requested);
    callback.port = String(address.port);
    try {
      await bind('::1', address.port);
    } catch (e) {
      if (!['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes((e as NodeJS.ErrnoException).code ?? ''))
        throw e;
    }
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    return { redirectUri: callback.href, result, close };
  } catch (e) {
    await close();
    throw new AirforceError(
      `Cannot bind OAuth callback port ${requested.port || 'dynamic'}. Close the application using it or configure another exactly registered redirect URI. ${e instanceof Error ? e.message : ''}`,
      'OAUTH_LISTENER',
      2,
    );
  }
}
async function postForm(
  url: string,
  body: URLSearchParams,
  signal: AbortSignal,
): Promise<Response> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      redirect: 'error',
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new AirforceError(
        `OAuth request failed (HTTP ${response.status}). Re-run airforce login and verify the registered redirect URI and public-client configuration.`,
        'OAUTH_HTTP',
        2,
      );
    }
    return response;
  } catch (e) {
    signal.throwIfAborted();
    if (e instanceof AirforceError) throw e;
    throw new AirforceError(
      'OAuth endpoint could not be reached. Check connectivity and run airforce login again.',
      'OAUTH_NETWORK',
    );
  }
}
export async function loginOAuth(
  config: Config,
  onAuthorize: (url: string) => Promise<void>,
  signal: AbortSignal,
): Promise<OAuthCredentials> {
  const issuer = new URL(config.oauthIssuer).origin;
  if (!config.baseUrl || new URL(config.baseUrl).origin !== issuer)
    throw new AirforceError(
      'OAuth issuer and API base URL must have the same origin. Check user configuration.',
      'OAUTH_CONFIG',
      2,
    );
  const effective = AbortSignal.any([signal, AbortSignal.timeout(180000)]);
  const pair = pkce();
  const listener = await listenForCode(config.oauthRedirectUri, pair.state, effective);
  try {
    const url = new URL('/oauth/authorize', issuer);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: config.oauthClientId,
      redirect_uri: listener.redirectUri,
      scope: config.oauthScopes.join(' '),
      state: pair.state,
      code_challenge: pair.challenge,
      code_challenge_method: 'S256',
    }).toString();
    await onAuthorize(url.href);
    const code = await listener.result;
    await listener.close();
    const response = await postForm(
      new URL('/oauth/token', issuer).href,
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: config.oauthClientId,
        code,
        redirect_uri: listener.redirectUri,
        code_verifier: pair.verifier,
      }),
      effective,
    );
    const data = z
      .object({
        access_token: z.string().min(1).max(8192),
        token_type: z.string().refine((s) => s.toLowerCase() === 'bearer'),
        expires_in: z.number().int().positive().max(604800),
        scope: z.string().optional(),
      })
      .safeParse(JSON.parse(await boundedText(response, 64000)));
    if (!data.success)
      throw new AirforceError(
        'OAuth token response is malformed. No credentials were saved.',
        'OAUTH_PROTOCOL',
      );
    const scope = data.data.scope ?? config.oauthScopes.join(' ');
    if (!['profile', 'chat'].every((s) => scope.split(' ').includes(s)))
      throw new AirforceError(
        'OAuth requires profile and chat consent. No credentials were saved.',
        'OAUTH_SCOPE',
        2,
      );
    const credentials: OAuthCredentials = {
      kind: 'oauth',
      accessToken: data.data.access_token,
      expiresAt: Date.now() + Math.min(data.data.expires_in, 86400) * 1000,
      scope,
      issuer,
      clientId: config.oauthClientId,
    };
    const profile = await request(
      new URL('/oauth/userinfo', issuer).href,
      { headers: { authorization: `Bearer ${credentials.accessToken}` } },
      effective,
    );
    const user = z
      .object({ id: z.string(), username: z.string().optional() })
      .safeParse(JSON.parse(await boundedText(profile, 64000)));
    if (!user.success)
      throw new AirforceError(
        'OAuth profile validation failed. No credentials were saved.',
        'OAUTH_PROTOCOL',
      );
    credentials.username = user.data.username;
    return credentials;
  } finally {
    await listener.close();
  }
}
export async function revokeOAuth(
  credentials: OAuthCredentials,
  signal: AbortSignal,
): Promise<void> {
  const issuer = new URL(credentials.issuer);
  if (
    issuer.protocol !== 'https:' &&
    !['localhost', '127.0.0.1', '[::1]'].includes(issuer.hostname)
  )
    throw new AirforceError('Unsafe OAuth issuer', 'OAUTH_CONFIG');
  const response = await postForm(
    new URL('/oauth/revoke', issuer).href,
    new URLSearchParams({ token: credentials.accessToken }),
    signal,
  );
  await response.body?.cancel();
}
