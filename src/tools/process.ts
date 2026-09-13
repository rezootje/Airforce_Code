import crossSpawn from 'cross-spawn';
const { spawn } = crossSpawn;
import { AirforceError } from '../utils/errors.js';
import { sanitize } from '../security/redact.js';
export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}
export interface Executor {
  run(
    command: string,
    args: string[],
    cwd: string,
    signal: AbortSignal,
    timeout?: number,
    onOutput?: (text: string, stream: 'stdout' | 'stderr') => void,
  ): Promise<ProcessResult>;
}
export class LocalExecutor implements Executor {
  async run(
    command: string,
    args: string[],
    cwd: string,
    signal: AbortSignal,
    timeout = 60000,
    onOutput?: (text: string, stream: 'stdout' | 'stderr') => void,
  ): Promise<ProcessResult> {
    signal.throwIfAborted();
    if (!command || command.includes('\0') || args.some((a) => a.includes('\0')))
      throw new AirforceError('Invalid executable arguments', 'COMMAND');
    if (process.platform === 'win32' && [command, ...args].some((value) => /[\r\n]/.test(value)))
      throw new AirforceError(
        'Windows command arguments cannot contain newlines. Write a script file instead.',
        'COMMAND',
      );
    // Deliberately no inherited API keys, token variables or repository-controlled shell environment.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      PATHEXT: process.env.PATHEXT,
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      LANG: 'C.UTF-8',
      NO_COLOR: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    };
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      let bytes = 0;
      let timedOut = false;
      let exceeded = false;
      let killTimer: NodeJS.Timeout | undefined;
      const pending = { stdout: '', stderr: '' };
      function kill(): void {
        if (!child.pid) return;
        if (process.platform === 'win32') {
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          });
          killer.on('error', () => child.kill());
        } else {
          try {
            process.kill(-child.pid, 'SIGTERM');
          } catch {
            child.kill('SIGTERM');
          }
          killTimer ??= setTimeout(() => {
            try {
              process.kill(-child.pid!, 'SIGKILL');
            } catch {
              /* process already exited */
            }
          }, 500);
          // Keep the escalation timer alive so detached descendants cannot outlive CLI exit.
        }
      }
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeout);
      timer.unref();
      const abort = () => kill();
      signal.addEventListener('abort', abort, { once: true });
      function cleanup(): void {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
      }
      for (const stream of ['stdout', 'stderr'] as const) {
        child[stream].setEncoding('utf8');
        child[stream].on('data', (data: string) => {
          bytes += Buffer.byteLength(data);
          if (bytes > 1_000_000) {
            exceeded = true;
            kill();
            return;
          }
          if (stream === 'stdout') stdout += data;
          else stderr += data;
          pending[stream] += data;
          const end = pending[stream].lastIndexOf('\n');
          if (end >= 0) {
            onOutput?.(sanitize(pending[stream].slice(0, end + 1)), stream);
            pending[stream] = pending[stream].slice(end + 1);
          }
        });
      }
      child.on('error', (e) => {
        cleanup();
        reject(new AirforceError(`Cannot execute ${command}: ${e.message}`, 'COMMAND'));
      });
      child.on('close', (code) => {
        cleanup();
        for (const stream of ['stdout', 'stderr'] as const)
          if (pending[stream]) onOutput?.(sanitize(pending[stream]), stream);
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        if (exceeded) {
          reject(
            new AirforceError(
              'Command exceeded 1 MB output limit and was terminated',
              'COMMAND_LIMIT',
            ),
          );
          return;
        }
        resolve({
          stdout: sanitize(stdout),
          stderr: sanitize(stderr),
          exitCode: code ?? 1,
          timedOut,
        });
      });
    });
  }
}
