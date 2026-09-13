import type { Credentials } from '../auth/credentials.js';
import type { Config } from '../config/config.js';

export type StartupAction = 'setup' | 'authenticate' | 'continue';

export function startupAction(options: {
  explicitSetup: boolean;
  interactive: boolean;
  hasPrompt: boolean;
  config: Config;
  credentials?: Credentials;
  now?: number;
}): StartupAction {
  if (options.explicitSetup) return 'setup';
  if (!options.interactive || options.hasPrompt) return 'continue';
  if (!options.config.onboardingComplete) return 'setup';
  if (!options.credentials) return 'authenticate';
  if (
    options.credentials.kind === 'oauth' &&
    options.credentials.expiresAt <= (options.now ?? Date.now()) + 30_000
  )
    return 'authenticate';
  return 'continue';
}
