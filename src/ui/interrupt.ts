import { emitKeypressEvents } from 'node:readline';

export interface InterruptKey {
  name?: string;
}

export function isInterruptKey(key: InterruptKey): boolean {
  return key.name === 'escape';
}

export function captureEscape(onInterrupt: () => void): () => void {
  const input = process.stdin;
  if (!input.isTTY) return () => undefined;
  const previousRaw = input.isRaw;
  let active = true;
  const onKeypress = (_text: string | undefined, key: InterruptKey) => {
    if (!active) return;
    if (isInterruptKey(key)) {
      active = false;
      onInterrupt();
    }
  };
  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  input.on('keypress', onKeypress);
  return () => {
    input.off('keypress', onKeypress);
    input.setRawMode(previousRaw ?? false);
    if (!previousRaw) input.pause();
  };
}
