import type { AgentEvent } from '../agent/types.js';
import { sanitize, Redactor } from '../security/redact.js';
import pc from 'picocolors';
import { ActivityIndicator } from './activity.js';
import { createTheme } from './theme.js';
import { formatTokens, formatUsd } from '../models/pricing.js';
import { MarkdownStream } from './markdown.js';
export interface OutputOptions {
  json?: boolean;
  jsonl?: boolean;
  quiet?: boolean;
  color?: boolean;
}
export class Output {
  redactor = new Redactor();
  private streaming = false;
  private readonly colors;
  private readonly activity: ActivityIndicator;
  private readonly markdown?: MarkdownStream;
  private latestUsage?: Extract<AgentEvent, { type: 'usage' }>;
  private shownToolOutput = 0;
  private toolOutputTruncated = false;
  constructor(readonly options: OutputOptions) {
    const interactive =
      !!process.stdout.isTTY &&
      !!process.stderr.isTTY &&
      !options.json &&
      !options.jsonl &&
      !options.quiet;
    const color = options.color !== false && !process.env.NO_COLOR && !!process.stdout.isTTY;
    this.colors = pc.createColors(color);
    const theme = createTheme(color);
    this.activity = new ActivityIndicator(theme, interactive);
    if (interactive) this.markdown = new MarkdownStream(theme, { color });
  }
  idle(): void {
    this.activity.stop();
  }
  working(label: string): void {
    this.activity.begin(label);
  }
  event = (event: AgentEvent): void => {
    event = this.redactor.value(event);
    if (this.options.jsonl) {
      process.stdout.write(JSON.stringify(event) + '\n');
      return;
    }
    if (this.options.json) return;
    if (event.type === 'agent.started') {
      this.markdown?.clear();
      this.shownToolOutput = 0;
      this.toolOutputTruncated = false;
      this.activity.begin('Working');
      return;
    }
    if (event.type === 'agent.progress') {
      this.activity.update(sanitize(event.message));
      return;
    }
    if (event.type === 'assistant.delta') {
      const rendered = this.markdown?.push(sanitize(event.text)) ?? sanitize(event.text);
      if (!rendered) {
        this.activity.update('Writing response');
        return;
      }
      this.activity.suspend();
      process.stdout.write(rendered);
      this.streaming = true;
      this.activity.update('Writing response');
      this.activity.resume();
      return;
    }
    if (event.type === 'assistant.message') {
      const remainder = this.markdown?.flush() ?? '';
      if (remainder) {
        this.activity.suspend();
        process.stdout.write(remainder);
        this.streaming = true;
      }
      if (this.streaming) process.stdout.write('\n');
      this.streaming = false;
      this.activity.resume();
      return;
    }
    if (event.type === 'usage') {
      this.latestUsage = event;
      return;
    }
    if (event.type === 'agent.completed') {
      const remainder = this.markdown?.flush() ?? '';
      if (remainder) {
        this.activity.suspend();
        process.stdout.write(`${remainder}\n`);
      }
      this.activity.stop();
      if (this.latestUsage && !this.options.quiet) {
        const usage = this.latestUsage;
        const cost = usage.sessionPriced
          ? `est. ${formatUsd(usage.sessionCostUsd)}`
          : 'price unavailable';
        process.stderr.write(
          this.colors.dim(
            `  Session · ${formatTokens(usage.sessionInput)} input · ${formatTokens(usage.sessionOutput)} output · ${cost}`,
          ) + '\n',
        );
      }
      return;
    }
    if (event.type === 'permission.requested') {
      this.activity.suspend();
      return;
    }
    if (event.type === 'permission.resolved') {
      this.activity.resume();
      return;
    }
    if (this.options.quiet) return;
    if (event.type === 'tool.output') {
      if (this.toolOutputTruncated) return;
      const clean = sanitize(event.text);
      const remaining = 16000 - this.shownToolOutput;
      if (remaining <= 0) {
        this.toolOutputTruncated = true;
        this.activity.suspend();
        process.stderr.write(this.colors.dim('  │ … live output hidden after 16 KB\n'));
        this.activity.resume();
        return;
      }
      const value = clean.slice(0, remaining);
      this.shownToolOutput += value.length;
      this.activity.suspend();
      const prefix =
        event.stream === 'stderr' ? this.colors.yellow('  │ ') : this.colors.dim('  │ ');
      process.stderr.write(
        value
          .split(/(?<=\n)/)
          .map((line) => (line ? prefix + line : ''))
          .join(''),
      );
      if (clean.length > value.length) this.toolOutputTruncated = true;
      this.activity.resume();
    } else if (event.type === 'tool.started') {
      this.activity.suspend();
      if (this.streaming) {
        process.stdout.write('\n');
        this.streaming = false;
      }
      process.stderr.write(this.colors.cyan(`  › ${sanitize(event.description)}`) + '\n');
      this.activity.update(sanitize(event.description));
      this.activity.resume();
    } else if (event.type === 'tool.completed') {
      this.activity.suspend();
      process.stderr.write(
        `  ${event.ok ? '✓' : '!'} ${sanitize(event.name)}${event.ok ? '' : ` [${sanitize(event.errorCode ?? 'TOOL_RESULT_ERROR')}]: ${sanitize(event.result).slice(0, 500)}`}\n`,
      );
      this.activity.update('Working');
      this.activity.resume();
    } else if (event.type === 'context.compacted') {
      this.activity.suspend();
      process.stderr.write(`  Context compacted: ~${event.before} → ~${event.after} tokens\n`);
      this.activity.resume();
    } else if (event.type === 'warning') {
      this.activity.suspend();
      process.stderr.write(`  Warning: ${sanitize(event.message)}\n`);
      this.activity.resume();
    }
  };
  print(value: unknown): void {
    this.activity.stop();
    value = this.redactor.value(value);
    if (this.options.json || this.options.jsonl) process.stdout.write(JSON.stringify(value) + '\n');
    else
      process.stdout.write(
        sanitize(typeof value === 'string' ? value : JSON.stringify(value, null, 2)) + '\n',
      );
  }
}
