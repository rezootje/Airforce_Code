import type { Theme } from './theme.js';

const frames = ['✦', '✧', '◆', '◇'];

export function workingFrame(
  label: string,
  elapsedMs: number,
  frame: number,
  width: number,
): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const suffix = seconds ? ` · ${seconds}s` : '';
  const available = Math.max(8, width - suffix.length - 5);
  const characters = [...label];
  const text =
    characters.length > available
      ? `${characters.slice(0, Math.max(1, available - 1)).join('')}…`
      : label;
  return `${frames[frame % frames.length]} ${text}${suffix}`;
}

export class ActivityIndicator {
  private active = false;
  private visible = false;
  private label = 'Working';
  private startedAt = 0;
  private frame = 0;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly theme: Theme,
    private readonly enabled: boolean,
  ) {}

  begin(label = 'Working'): void {
    if (!this.enabled) return;
    this.stop();
    this.active = true;
    this.label = label;
    this.startedAt = Date.now();
    this.frame = 0;
    this.resume();
  }

  update(label: string): void {
    if (!this.enabled || !this.active) return;
    this.label = label;
    if (this.timer) this.draw();
  }

  suspend(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.clear();
  }

  resume(): void {
    if (!this.enabled || !this.active || this.timer) return;
    this.draw();
    this.timer = setInterval(() => this.draw(), 90);
    this.timer.unref();
  }

  stop(): void {
    this.active = false;
    this.suspend();
  }

  private clear(): void {
    if (!this.visible) return;
    process.stderr.write('\r\x1b[2K');
    this.visible = false;
  }

  private draw(): void {
    this.clear();
    const text = workingFrame(
      this.label,
      Date.now() - this.startedAt,
      this.frame++,
      Math.max(20, (process.stderr.columns ?? 80) - 20),
    );
    process.stderr.write(`\r${this.theme.accent(text)} ${this.theme.muted('Esc to interrupt')}`);
    this.visible = true;
  }
}
