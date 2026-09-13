export interface SlashCommand {
  name: string;
  description: string;
  usage?: string;
  prompt?: string;
}
export const slashCommands: SlashCommand[] = [
  { name: 'help', description: 'Commands, input and shortcuts' },
  {
    name: 'auth',
    description: 'Replace API key or sign in again with OAuth',
    usage: '[api-key|oauth]',
  },
  {
    name: 'model',
    description: 'Search/select models; refresh model discovery',
    usage: '[refresh | model-id]',
  },
  {
    name: 'init',
    description: 'Inspect project and draft a concise AIRFORCE.md',
    prompt:
      'Inspect this project and create a concise AIRFORCE.md with verified architecture, commands, conventions, tests and directories to avoid. Read any existing instructions first. Do not overwrite existing guidance without preserving it.',
  },
  { name: 'compact', description: 'Summarize context; keep full history on disk' },
  { name: 'clear', description: 'Clear terminal display (history retained)' },
  {
    name: 'review',
    description: 'Review changes for concrete correctness/security issues',
    prompt:
      'Review the current Git diff. Focus on concrete bugs, regressions, security, edge cases, compatibility and missing tests. Include file and line references and severity. Do not edit files.',
  },
  { name: 'diff', description: 'Show current unstaged diff' },
  {
    name: 'permissions',
    description: 'Inspect or select permission mode',
    usage: '[ask|edit|auto]',
  },
  { name: 'status', description: 'Session, model, repository, Git and permissions' },
  { name: 'resume', description: 'Resume a saved session', usage: '[id]' },
  { name: 'sessions', description: 'List saved sessions' },
  { name: 'new', description: 'Start a new conversation' },
  { name: 'config', description: 'Inspect or change ordinary user settings' },
  { name: 'instructions', description: 'Show loaded project instructions and precedence' },
  {
    name: 'question',
    description: 'Toggle clarification-first mode; all mutations blocked',
    usage: '[off | request]',
  },
  { name: 'undo', description: 'Undo last tracked file edit if content still matches' },
  { name: 'redo', description: 'Redo a previously undone edit if content still matches' },
  { name: 'files', description: 'Show files read for context' },
  { name: 'context', description: 'Show estimated context usage' },
  { name: 'git', description: 'Show Git status' },
  {
    name: 'commit',
    description: 'Review tracked changes and propose/create a commit with approval',
    prompt:
      'Inspect Git status and diff, identify changes exclusively made in this Airforce session, summarize exactly what would be committed, and propose a commit message. Use git_commit only for tracked paths. It will request approval. Never include pre-existing user work.',
  },
  {
    name: 'branch',
    description: 'Inspect branches or create a branch with approval',
    usage: '[name]',
  },
  { name: 'tools', description: 'List registered tools' },
  {
    name: 'mcp',
    description: 'List or explicitly connect configured MCP servers',
    usage: '[connect name]',
  },
  { name: 'hooks', description: 'Inspect configured permission-aware hooks' },
  { name: 'history', description: 'Show recent conversation' },
  { name: 'export', description: 'Export the current session as JSON to stdout' },
  { name: 'doctor', description: 'Check configuration, API and local environment' },
  { name: 'exit', description: 'Save and exit' },
];
export function parseSlash(value: string): { name: string; args: string } | undefined {
  if (!value.startsWith('/')) return undefined;
  const match = /^\/([^\s]+)\s*([\s\S]*)$/.exec(value.trim());
  return match ? { name: match[1]!, args: match[2] ?? '' } : { name: 'help', args: '' };
}
