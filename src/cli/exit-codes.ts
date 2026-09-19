/** Process exit codes. Distinct per run outcome (spec §8). */
export const ExitCode = {
  Ok: 0,
  UnexpectedError: 1,
  UsageError: 2,
  NotImplemented: 3,
  GateWaiting: 10,
  WaitExceeded: 11,
  Escalated: 12,
  Locked: 13,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];
