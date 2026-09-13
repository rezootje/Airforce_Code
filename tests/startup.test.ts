import { describe, expect, it } from 'vitest';
import { configSchema } from '../src/config/config.js';
import { startupAction } from '../src/cli/startup.js';

describe('startup routing', () => {
  const completed = configSchema.parse({
    onboardingComplete: true,
    model: 'airforce-model',
  });

  it('runs full onboarding only when it is incomplete or explicitly requested', () => {
    expect(
      startupAction({
        explicitSetup: false,
        interactive: true,
        hasPrompt: false,
        config: configSchema.parse({}),
      }),
    ).toBe('setup');
    expect(
      startupAction({
        explicitSetup: true,
        interactive: true,
        hasPrompt: false,
        config: completed,
        credentials: { kind: 'api-key', apiKey: 'test-key' },
      }),
    ).toBe('setup');
  });

  it('uses focused authentication after onboarding when credentials are missing or expired', () => {
    expect(
      startupAction({
        explicitSetup: false,
        interactive: true,
        hasPrompt: false,
        config: completed,
      }),
    ).toBe('authenticate');
    expect(
      startupAction({
        explicitSetup: false,
        interactive: true,
        hasPrompt: false,
        config: completed,
        credentials: {
          kind: 'oauth',
          accessToken: 'expired-token',
          expiresAt: 30_000,
          scope: 'profile chat',
          issuer: 'https://api.airforce',
          clientId: 'public-client',
        },
        now: 1,
      }),
    ).toBe('authenticate');
  });

  it('continues directly after completed onboarding with valid credentials', () => {
    expect(
      startupAction({
        explicitSetup: false,
        interactive: true,
        hasPrompt: false,
        config: completed,
        credentials: { kind: 'api-key', apiKey: 'test-key' },
      }),
    ).toBe('continue');
  });
});
