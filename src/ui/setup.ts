import { input, password, search, select, confirm } from '@inquirer/prompts';
import type { Config } from '../config/config.js';
import { endpointSchema, FileAuthStore, saveConfig } from '../config/config.js';
import { AirforceProvider } from '../providers/airforce.js';
import type { Model } from '../agent/types.js';
import { AIRFORCE_API_URL } from '../auth/constants.js';
import { loginOAuth } from '../auth/oauth.js';
import { openBrowser } from '../auth/browser.js';
import { type Credentials } from '../auth/credentials.js';
import { sanitize } from '../security/redact.js';
import { logo, panel } from './brand.js';
import { createTheme } from './theme.js';
import { formatModelPricing } from '../models/pricing.js';
export type AuthMethod = 'api-key' | 'oauth';

async function chooseAuthentication(method?: AuthMethod): Promise<AuthMethod> {
  return (
    method ??
    (await select({
      message: 'Authentication',
      choices: [
        { name: 'API Key', value: 'api-key' as const },
        { name: 'Sign in with Airforce — OAuth', value: 'oauth' as const },
      ],
    }))
  );
}

async function enterCredentials(
  config: Config,
  method: AuthMethod,
  browser: boolean | undefined,
): Promise<Credentials> {
  if (method === 'api-key')
    return {
      kind: 'api-key',
      apiKey: await password({
        message: 'API key',
        mask: '*',
        validate: (value) => value.trim().length > 0 || 'An API key is required',
      }),
    };
  const controller = new AbortController();
  const abort = () => controller.abort(new Error('Sign-in cancelled'));
  process.once('SIGINT', abort);
  try {
    return await loginOAuth(
      config,
      async (url) => {
        process.stderr.write(`\nOpen this URL in your browser to sign in:\n${url}\n\n`);
        if (browser !== false)
          try {
            await openBrowser(url);
          } catch {
            process.stderr.write(
              'Browser could not be opened automatically. Open the URL above manually.\n',
            );
          }
      },
      controller.signal,
    );
  } finally {
    process.off('SIGINT', abort);
  }
}
export function fuzzyScore(query: string, value: string): number {
  const q = query.toLowerCase();
  const v = value.toLowerCase();
  if (v.includes(q)) return 1000 - v.indexOf(q);
  let pos = -1;
  let score = 0;
  for (const char of q) {
    const next = v.indexOf(char, pos + 1);
    if (next < 0) return -1;
    score += next === pos + 1 ? 5 : 1;
    pos = next;
  }
  return score;
}
export async function pickModel(models: Model[], config: Config): Promise<Model> {
  const order = new Map(models.map((model, index) => [model.id, index]));
  const id = await search({
    message: 'Select a model · search by name or ID',
    pageSize: 12,
    source: async (term) =>
      models
        .map((m) => ({ model: m, score: fuzzyScore(term ?? '', `${m.name ?? ''} ${m.id}`) }))
        .filter((x) => x.score >= 0)
        .sort((a, b) => {
          const aRecent = config.recentModels.indexOf(a.model.id);
          const bRecent = config.recentModels.indexOf(b.model.id);
          const aRank = a.model.id === config.model ? -2 : aRecent < 0 ? 1000 : aRecent;
          const bRank = b.model.id === config.model ? -2 : bRecent < 0 ? 1000 : bRecent;
          return (
            b.score - a.score || aRank - bRank || order.get(a.model.id)! - order.get(b.model.id)!
          );
        })
        .map(({ model: m }) => ({
          value: m.id,
          name: sanitize(
            `${m.name ?? m.id}${m.name ? ` (${m.id})` : ''}${m.id === config.model ? ' [default/current]' : config.recentModels.includes(m.id) ? ' [recent]' : ''}`,
          ),
          description: sanitize(
            `${formatModelPricing(m)} · Tools: ${m.capabilities.tools ?? 'unknown'} · Context: ${m.contextWindow ?? 'unknown'}`,
          ),
        })),
  });
  return models.find((m) => m.id === id)!;
}
export async function setup(
  config: Config,
  home: string,
  options: { method?: 'api-key' | 'oauth'; browser?: boolean; persist?: boolean } = {},
): Promise<{ config: Config; credentials: Credentials }> {
  const theme = createTheme();
  process.stderr.write(`\n${logo(theme)}\n\n`);
  process.stderr.write(
    `${panel(
      'Welcome to Airforce Code',
      [
        'A coding agent that works with you inside your projects.',
        '',
        'This one-time setup connects your account and chooses safe defaults.',
        'You can change every setting later with /config.',
      ],
      theme,
    )}\n\n`,
  );
  process.stderr.write(`${theme.muted('[1/4] Account')}\n`);
  const method = await chooseAuthentication(options.method);
  process.stderr.write(`\n${theme.muted('[2/4] API endpoint')}\n`);
  config.baseUrl = await input({
    message: 'API base URL (HTTPS; /v1 suffix optional)',
    default: config.baseUrl ?? AIRFORCE_API_URL,
    validate: (value) =>
      endpointSchema.safeParse(value).success ||
      'Enter a valid HTTPS URL (HTTP allowed for localhost tests).',
  });
  const credentials = await enterCredentials(config, method, options.browser);
  const provider = new AirforceProvider(config, credentials);
  const models = await provider.models();
  if (!models.length) throw new Error('The API returned no models. Check access for this API key.');
  process.stderr.write(
    `  ${theme.success('✓')} Credentials validated · ${models.length} models loaded.\n`,
  );
  process.stderr.write(`\n${theme.muted('[3/4] Default model')}\n`);
  config.model = (await pickModel(models, config)).id;
  config.recentModels = [
    config.model,
    ...config.recentModels.filter((model) => model !== config.model),
  ].slice(0, 10);
  process.stderr.write(`\n${theme.muted('[4/4] Safety defaults')}\n`);
  config.permissionMode = await select({
    message: 'Default permission mode',
    choices: [
      { name: 'Ask — approve edits and execution', value: 'ask' as const },
      { name: 'Edit — allow repository edits; approve execution', value: 'edit' as const },
      {
        name: 'Auto — allow ordinary file edits; approve unsandboxed execution',
        value: 'auto' as const,
      },
    ],
  });
  const persist =
    options.persist ??
    (await confirm({
      message:
        credentials.kind === 'oauth'
          ? 'Save sign-in in a private local credential file? (unencrypted; expires automatically)'
          : 'Save API key in a private local credential file? (unencrypted; choose No to use AIRFORCE_API_KEY)',
      default: credentials.kind === 'oauth',
    }));
  if (persist) await new FileAuthStore(home).save(credentials);
  config.onboardingComplete = true;
  await saveConfig(home, config);
  process.stderr.write(
    `\n${panel(
      'Setup complete',
      [
        `${theme.success('✓')} Account connected`,
        `${theme.success('✓')} Model: ${sanitize(config.model)}`,
        `${theme.success('✓')} Permission mode: ${config.permissionMode}`,
        'Telemetry is not collected.',
      ],
      theme,
    )}\n\n`,
  );
  if (credentials.kind === 'oauth')
    process.stderr.write(
      '  OAuth sign-in expires in 24 hours or sooner; use airforce login again when needed.\n',
    );
  return { config, credentials };
}

export async function updateAuthentication(
  config: Config,
  home: string,
  options: { method?: AuthMethod; browser?: boolean } = {},
): Promise<{ config: Config; credentials: Credentials }> {
  const theme = createTheme();
  process.stderr.write(`\n${logo(theme)}\n\n`);
  process.stderr.write(
    `${panel(
      'Authentication',
      [
        'Replace the saved API key or sign in again with OAuth.',
        'Existing credentials stay active until the replacement is validated.',
      ],
      theme,
    )}\n\n`,
  );
  const method = await chooseAuthentication(options.method);
  config.baseUrl = await input({
    message: 'API base URL',
    default: config.baseUrl ?? AIRFORCE_API_URL,
    validate: (value) =>
      endpointSchema.safeParse(value).success ||
      'Enter a valid HTTPS URL (HTTP allowed for localhost tests).',
  });
  const credentials = await enterCredentials(config, method, options.browser);
  const provider = new AirforceProvider(config, credentials);
  const models = await provider.models();
  if (!models.length) throw new Error('The API returned no models. Credentials were not changed.');
  const current = models.find((model) => model.id === config.model);
  if (!current) config.model = (await pickModel(models, config)).id;
  config.onboardingComplete = true;
  if (config.model)
    config.recentModels = [
      config.model,
      ...config.recentModels.filter((model) => model !== config.model),
    ].slice(0, 10);
  await new FileAuthStore(home).save(credentials);
  await saveConfig(home, config);
  process.stderr.write(
    `${theme.success('✓')} Authentication updated · ${models.length} models available${current ? ` · model ${sanitize(current.id)} retained` : ''}\n\n`,
  );
  return { config, credentials };
}
