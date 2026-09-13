import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { readFile, rm } from 'node:fs/promises';
import { z } from 'zod';
import { credentialsSchema, type Credentials as AuthCredentials } from '../auth/credentials.js';
import {
  AIRFORCE_API_URL,
  AIRFORCE_OAUTH_CLIENT_ID,
  AIRFORCE_OAUTH_REDIRECT_URI,
} from '../auth/constants.js';
import { atomicJson, safeStorageFile } from '../utils/storage.js';
import { isMissing, AirforceError } from '../utils/errors.js';
export const endpointSchema = z
  .string()
  .url()
  .superRefine((value, ctx) => {
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !['https:', 'http:'].includes(url.protocol)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Use an HTTP(S) endpoint without credentials, query or fragment',
      });
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      ctx.addIssue({
        code: 'custom',
        message: 'HTTPS is required except for loopback test servers',
      });
  });
export const mcpSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    enabled: z.boolean().default(false),
  })
  .strict();
export const configSchema = z
  .object({
    version: z.literal(1).default(1),
    onboardingComplete: z.boolean().default(false),
    baseUrl: endpointSchema.default(AIRFORCE_API_URL),
    oauthIssuer: endpointSchema
      .refine(
        (value) => new URL(value).pathname === '/' || new URL(value).pathname === '',
        'OAuth issuer must be an origin without a path',
      )
      .default(AIRFORCE_API_URL),
    oauthClientId: z.string().min(1).max(200).default(AIRFORCE_OAUTH_CLIENT_ID),
    oauthRedirectUri: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === 'http:' &&
          url.hostname === 'localhost' &&
          url.pathname === '/oauth/callback' &&
          Number(url.port) > 0 &&
          !url.search &&
          !url.hash &&
          !url.username &&
          !url.password
        );
      }, 'Use http://localhost:PORT/oauth/callback with an exactly registered port')
      .default(AIRFORCE_OAUTH_REDIRECT_URI),
    oauthScopes: z
      .array(z.enum(['profile', 'chat', 'images']))
      .refine(
        (scopes) => scopes.includes('profile') && scopes.includes('chat'),
        'profile and chat scopes are required',
      )
      .default(['profile', 'chat']),
    model: z.string().optional(),
    protocol: z.enum(['openai', 'anthropic']).default('openai'),
    permissionMode: z.enum(['ask', 'edit', 'auto']).default('ask'),
    maxTurns: z.number().int().min(1).max(200).default(30),
    contextTokens: z.number().int().min(4096).max(2_000_000).default(32000),
    maxOutputTokens: z.number().int().min(128).max(128000).default(4096),
    temperature: z.number().min(0).max(2).optional(),
    deniedPaths: z.array(z.string()).default([]),
    deniedCommands: z.array(z.string()).default([]),
    network: z.boolean().default(false),
    allowedCommands: z.array(z.array(z.string()).min(1)).default([]),
    hooks: z
      .array(
        z
          .object({
            event: z.enum([
              'before_tool',
              'after_tool',
              'before_write',
              'after_write',
              'before_command',
              'after_command',
            ]),
            tool: z.string().optional(),
            command: z.string().min(1),
            args: z.array(z.string()).default([]),
          })
          .strict(),
      )
      .default([]),
    recentModels: z.array(z.string()).max(10).default([]),
    mcpServers: z.record(z.string().regex(/^[a-zA-Z0-9_-]+$/), mcpSchema).default({}),
  })
  .strict();
export type Config = z.infer<typeof configSchema>;
export type Credentials = AuthCredentials;
export interface AuthStore {
  load(): Promise<Credentials | undefined>;
  save(credentials: Credentials): Promise<void>;
  clear(): Promise<void>;
}
export function dataDirectory(env = process.env): string {
  if (env.AIRFORCE_HOME) {
    if (!isAbsolute(env.AIRFORCE_HOME)) throw new AirforceError('AIRFORCE_HOME must be absolute');
    return env.AIRFORCE_HOME;
  }
  if (process.platform === 'win32') return join(env.LOCALAPPDATA ?? homedir(), 'Airforce');
  if (process.platform === 'darwin')
    return join(homedir(), 'Library', 'Application Support', 'Airforce');
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'airforce');
}
async function readJson(path: string, privateFile = true): Promise<Record<string, unknown>> {
  try {
    if (privateFile) await safeStorageFile(path);
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch (e) {
    if (isMissing(e)) return {};
    throw new AirforceError(
      `Cannot load ${path}: ${e instanceof Error ? e.message : String(e)}`,
      'CONFIG',
      2,
    );
  }
}
export class FileAuthStore implements AuthStore {
  constructor(private readonly home: string) {}
  async load(): Promise<Credentials | undefined> {
    const data = await readJson(join(this.home, 'credentials.json'));
    if (!Object.keys(data).length) return undefined;
    return credentialsSchema.parse(data);
  }
  async save(value: Credentials): Promise<void> {
    await atomicJson(join(this.home, 'credentials.json'), credentialsSchema.parse(value));
  }
  async clear(): Promise<void> {
    const path = join(this.home, 'credentials.json');
    await safeStorageFile(path);
    await rm(path, { force: true });
  }
}
export async function loadConfig(
  cwd: string,
  flags: Partial<Config> = {},
  env = process.env,
  includeProject = true,
): Promise<Config> {
  const user = await readJson(join(dataDirectory(env), 'config.json'));
  const project = includeProject ? await readJson(join(cwd, '.airforce.json'), false) : {};
  // Repository config cannot redirect credentials, change policy, or launch executables.
  const projectSchema = z
    .object({ model: z.string().optional(), contextTokens: z.number().optional() })
    .strict();
  const parsedProject = projectSchema.safeParse(project);
  if (!parsedProject.success)
    throw new AirforceError(`Invalid project config: ${parsedProject.error.message}`, 'CONFIG', 2);
  const environment = {
    baseUrl: env.AIRFORCE_BASE_URL,
    model: env.AIRFORCE_MODEL,
    permissionMode: env.AIRFORCE_PERMISSION_MODE,
    protocol: env.AIRFORCE_PROTOCOL,
  };
  const defined = (x: object) =>
    Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined));
  const parsed = configSchema.safeParse({
    ...user,
    ...parsedProject.data,
    ...defined(environment),
    ...defined(flags),
  });
  if (!parsed.success)
    throw new AirforceError(`Invalid configuration: ${parsed.error.message}`, 'CONFIG', 2);
  return parsed.data;
}
export async function saveConfig(home: string, config: Config): Promise<void> {
  await atomicJson(join(home, 'config.json'), configSchema.parse(config));
}
export async function loadUserConfig(home: string): Promise<Config> {
  return configSchema.parse(await readJson(join(home, 'config.json')));
}
