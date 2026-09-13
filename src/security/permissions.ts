import type { Action, Approval, Emit, Mode } from '../agent/types.js';
import type { Config } from '../config/config.js';
import { AirforceError } from '../utils/errors.js';
export function classifyCommand(command: string[]): Action['risk'] {
  const text = command.join(' ');
  if (/\b(sudo|doas|su|shutdown|reboot|mkfs\w*|diskpart|format|mount|umount)\b/i.test(text))
    return 'privileged';
  if (
    /\b(rm|rmdir|del|erase|Remove-Item)\b|\b(reset\s+--hard|clean\s+-|push\b.*(?:--force|-f)|checkout\s+--|restore|revert)\b/i.test(
      text,
    )
  )
    return 'destructive';
  if (
    /\b(curl|wget|ssh|scp|git\s+(?:push|fetch|pull|clone)|npm\s+(?:install|publish))\b/i.test(text)
  )
    return 'network';
  return 'execute';
}
export class PermissionPolicy {
  questionFirst = false;
  constructor(
    public mode: Mode,
    private readonly config: Pick<Config, 'deniedCommands' | 'network' | 'allowedCommands'>,
    private readonly approve: Approval,
    private readonly emit: Emit,
  ) {}
  async require(action: Action): Promise<void> {
    if (this.questionFirst && action.risk !== 'read')
      throw new AirforceError(
        'Question-first mode: ask the user before implementation. Use /question off after resolving questions.',
        'PERMISSION',
        3,
      );
    if (
      action.command &&
      this.config.deniedCommands.some((prefix) => action.command!.join(' ').startsWith(prefix))
    )
      throw new AirforceError('Command denied by configuration', 'PERMISSION', 3);
    if (action.risk === 'network' && !this.config.network)
      throw new AirforceError(
        'Optional network tools are disabled. Enable network in user config.',
        'PERMISSION',
        3,
      );
    if (
      action.risk === 'execute' &&
      action.tool === 'run_command' &&
      action.command &&
      this.config.allowedCommands.some(
        (argv) => JSON.stringify(argv) === JSON.stringify(action.command),
      )
    )
      return;
    if (action.risk === 'read' || (action.risk === 'write' && this.mode !== 'ask')) return;
    this.emit({ type: 'permission.requested', action });
    const allowed = await this.approve(action);
    this.emit({ type: 'permission.resolved', action, allowed });
    if (!allowed)
      throw new AirforceError(`Permission denied: ${action.description}`, 'PERMISSION', 3);
  }
}
