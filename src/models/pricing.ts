import type { Model } from '../agent/types.js';

export function formatUsd(value: number): string {
  if (value === 0) return '$0.00';
  if (value < 0.0001) return `$${value.toFixed(6)}`;
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

export function formatTokens(value: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(
    value,
  );
}

export function formatModelPricing(model: Model): string {
  const input = model.pricing?.inputPerMillionUsd;
  const output = model.pricing?.outputPerMillionUsd;
  if (input === undefined && output === undefined) return 'Pricing unavailable';
  return `Input ${input === undefined ? '—' : formatUsd(input)} · Output ${output === undefined ? '—' : formatUsd(output)} / 1M`;
}
