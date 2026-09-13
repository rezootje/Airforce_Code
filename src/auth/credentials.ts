import { z } from 'zod';
import { AirforceError } from '../utils/errors.js';
import { AIRFORCE_API_URL } from './constants.js';
export const credentialsSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('api-key'), apiKey: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal('oauth'),
      accessToken: z.string().min(1),
      expiresAt: z.number().int().positive(),
      scope: z.string(),
      issuer: z.string().url(),
      clientId: z.string().min(1),
      username: z.string().optional(),
    })
    .strict(),
]);
export type Credentials = z.infer<typeof credentialsSchema>;
export type OAuthCredentials = Extract<Credentials, { kind: 'oauth' }>;
export function credentialToken(credentials: Credentials): string {
  return credentials.kind === 'api-key' ? credentials.apiKey : credentials.accessToken;
}
export function assertCredentials(credentials: Credentials, baseUrl: string): void {
  if (credentials.kind === 'oauth') {
    if (new URL(baseUrl).origin !== new URL(AIRFORCE_API_URL).origin)
      throw new AirforceError(
        'OAuth is available only with the default api.airforce service. The configured endpoint is a different API origin; use an API key for a custom endpoint.',
        'AUTH_ENDPOINT',
        2,
      );
    if (credentials.expiresAt <= Date.now() + 30000)
      throw new AirforceError(
        'OAuth session expired. Run airforce login to sign in again.',
        'AUTH_EXPIRED',
        2,
      );
    if (new URL(baseUrl).origin !== new URL(credentials.issuer).origin)
      throw new AirforceError(
        'OAuth token belongs to a different API origin. Use the matching endpoint or sign in to that deployment.',
        'AUTH_ORIGIN',
        2,
      );
  }
}
