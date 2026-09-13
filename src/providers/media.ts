import { assertCredentials, credentialToken, type Credentials } from '../auth/credentials.js';
import type { Config } from '../config/config.js';
import type { MediaProvider } from '../extensions/interfaces.js';
import { endpoint, request, boundedText } from './http.js';
import { z } from 'zod';
import { AirforceError } from '../utils/errors.js';
export class AirforceMediaProvider implements MediaProvider {
  constructor(
    private readonly config: Config,
    private readonly credentials: string | Credentials,
  ) {}
  async generateImage(
    input: { model: string; prompt: string },
    signal: AbortSignal,
  ): Promise<{ bytes: Uint8Array; mimeType: 'image/png' }> {
    if (!this.config.baseUrl) throw new AirforceError('Configure an API endpoint', 'CONFIG');
    if (typeof this.credentials !== 'string') {
      assertCredentials(this.credentials, this.config.baseUrl);
      if (
        this.credentials.kind === 'oauth' &&
        !this.credentials.scope.split(' ').includes('images')
      )
        throw new AirforceError(
          'OAuth images scope is missing. Configure oauthScopes and run airforce login again.',
          'AUTH_SCOPE',
          2,
        );
    }
    const token =
      typeof this.credentials === 'string' ? this.credentials : credentialToken(this.credentials);
    const response = await request(
      endpoint(this.config.baseUrl, 'images/generations'),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...input, n: 1, response_format: 'b64_json' }),
      },
      AbortSignal.any([signal, AbortSignal.timeout(180000)]),
    );
    const wire = z
      .object({
        data: z
          .array(
            z.object({
              b64_json: z
                .string()
                .regex(/^[a-zA-Z0-9+/]+={0,2}$/)
                .max(8_000_000),
            }),
          )
          .length(1),
      })
      .safeParse(JSON.parse(await boundedText(response, 9_000_000)));
    if (!wire.success)
      throw new AirforceError(
        'Image endpoint must return one base64 PNG (b64_json); remote image URLs and other formats are not supported.',
        'MEDIA',
      );
    const bytes = Buffer.from(wire.data.data[0]!.b64_json, 'base64');
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      throw new AirforceError('Image response is not a PNG', 'MEDIA');
    return { bytes, mimeType: 'image/png' };
  }
}
