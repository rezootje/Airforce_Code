import { it, expect } from 'vitest';
import { regexSearch } from '../src/tools/regex.js';
it('finds symbols with line references using an isolated regex worker', async () => {
  expect(
    await regexSearch(
      {
        pattern: '^(export )?function \\w+',
        caseSensitive: true,
        limit: 10,
        files: [{ path: 'a.ts', content: '// start\nexport function example() {}' }],
      },
      new AbortController().signal,
    ),
  ).toMatchObject({ matches: [{ path: 'a.ts', line: 2 }] });
});
it('terminates catastrophic backtracking without blocking the agent', async () => {
  await expect(
    regexSearch(
      {
        pattern: '^(a+)+$',
        caseSensitive: true,
        limit: 10,
        files: [{ path: 'a', content: 'a'.repeat(30000) + '!' }],
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow('budget');
});
