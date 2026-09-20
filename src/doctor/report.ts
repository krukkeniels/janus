import { ExitCode } from '../cli/exit-codes.js';
import { DoctorContractError } from './types.js';
import type { DoctorCheck, DoctorCheckContext, DoctorFinding, DoctorObservation, DoctorStatus } from './types.js';

export interface DoctorReport {
  /** Bumped only when a field is removed or changes meaning; new fields are additive. */
  version: 1;
  generated_at: string;
  /** Absolute workspace root, or null when doctor ran outside one. */
  workspace: string | null;
  summary: Record<DoctorStatus, number>;
  checks: DoctorFinding[];
}

export async function runDoctor(checks: readonly DoctorCheck[], ctx: DoctorCheckContext): Promise<DoctorReport> {
  const findings: DoctorFinding[] = [];
  for (const check of checks) {
    const started = ctx.now().getTime();
    let observations: DoctorObservation[];
    try {
      observations = await check.run(ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      observations = [
        {
          id: check.id,
          title: check.title,
          status: 'fail' as const,
          detail: `the check itself threw: ${message}`,
          remediation: 'this is a bug in janus doctor, not in your environment; report it with the message above',
        },
      ];
    }
    const durationMs = ctx.now().getTime() - started;
    for (const observation of observations) findings.push({ ...observation, duration_ms: durationMs });
  }

  const seen = new Set<string>();
  for (const finding of findings) {
    if (seen.has(finding.id)) throw new DoctorContractError(`two doctor findings share the id "${finding.id}"; ids are the --json contract's key`);
    seen.add(finding.id);
    if (finding.status !== 'pass' && finding.remediation === null) {
      throw new DoctorContractError(`doctor finding "${finding.id}" is ${finding.status} but carries no remediation`);
    }
  }

  // The literal below carries all four keys, so the summary's key set is exactly `DOCTOR_STATUSES` even when a
  // status never occurred — `--json` consumers can read `summary.fail` without a presence check.
  const summary: Record<DoctorStatus, number> = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const finding of findings) summary[finding.status] += 1;

  return {
    version: 1,
    generated_at: ctx.now().toISOString(),
    workspace: ctx.paths?.root ?? null,
    summary,
    checks: findings,
  };
}

export function doctorExitCode(report: DoctorReport): ExitCode {
  return report.summary.fail > 0 ? ExitCode.UnexpectedError : ExitCode.Ok;
}

export function doctorJson(report: DoctorReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

const TAGS: Record<DoctorStatus, string> = { pass: '[ok]  ', warn: '[warn]', fail: '[fail]', skip: '[skip]' };

export function renderDoctorHuman(report: DoctorReport): string {
  const width = Math.max(0, ...report.checks.map((finding) => finding.id.length));
  const lines = ['janus doctor', ''];
  for (const finding of report.checks) {
    lines.push(`  ${TAGS[finding.status]} ${finding.id.padEnd(width)}  ${finding.detail}`);
    if (finding.status !== 'pass' && finding.remediation !== null) lines.push(`         -> ${finding.remediation}`);
  }
  const { pass, warn, fail, skip } = report.summary;
  lines.push(
    '',
    `${String(report.checks.length)} checks: ${String(pass)} ok, ${String(warn)} warnings, ${String(fail)} failed, ${String(skip)} skipped`,
  );
  return `${lines.join('\n')}\n`;
}
