import { ConfigError } from '../config/errors.js';

/** Parses `500ms`, `30s`, `45m`, `2h` into milliseconds. */
export function parseDuration(value: string, option: string): number {
  const match = /^(\d+)(ms|s|m|h)$/.exec(value.trim());
  const amount = match?.[1];
  const unit = match?.[2];
  if (amount === undefined || unit === undefined) {
    throw new ConfigError(option, [`invalid duration "${value}"; use a whole number with unit ms, s, m, or h, for example 45m`]);
  }
  switch (unit) {
    case 'ms':
      return Number(amount);
    case 's':
      return Number(amount) * 1_000;
    case 'm':
      return Number(amount) * 60_000;
    default:
      return Number(amount) * 3_600_000;
  }
}
