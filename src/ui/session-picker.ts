import { search } from '@inquirer/prompts';
import type { Session } from '../sessions/store.js';
import { sanitize } from '../security/redact.js';
import { formatTokens, formatUsd } from '../models/pricing.js';

function relativeTime(value: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - new Date(value).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(value).toLocaleDateString();
}

export async function pickSession(sessions: Session[]): Promise<string> {
  const id = await search({
    message: 'Resume a session · search by title or ID',
    pageSize: 10,
    source: async (term) => {
      const query = (term ?? '').toLowerCase();
      return sessions
        .filter(
          (session) =>
            !query ||
            session.title.toLowerCase().includes(query) ||
            session.id.toLowerCase().includes(query),
        )
        .map((session) => ({
          name: sanitize(session.title),
          value: session.id,
          description: sanitize(
            `${relativeTime(session.updatedAt)} · ${session.messages.length} messages · ${formatTokens(session.usage.inputTokens + session.usage.outputTokens)} tokens · ${session.usage.priced ? `est. ${formatUsd(session.usage.costUsd)}` : 'price unavailable'} · ${session.id.slice(0, 8)}`,
          ),
        }));
    },
  });
  return id;
}
