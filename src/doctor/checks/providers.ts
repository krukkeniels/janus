import { skipped } from '../types.js';
import type { DoctorCheck, DoctorCheckContext, DoctorObservation } from '../types.js';

const PROBE_TIMEOUT_MS = 15_000;
const NO_WORKSPACE = 'run janus doctor from inside a janus workspace, or run janus init first';

interface ReachabilityInput {
  ctx: DoctorCheckContext;
  id: string;
  title: string;
  /** The human name of the system, for the detail line. */
  system: string;
  url: string;
  tokenEnv: string;
}

/**
 * Strips a URL's userinfo (`user:pass@`) before the URL is allowed anywhere near a finding. §32 rule 12: a
 * configured provider URL can legitimately embed credentials, and a reachability check's natural instinct is to
 * quote the URL it probed in the detail line — which would leak that credential into a report an operator pastes
 * into chat. The raw, possibly-credentialed URL is still what gets sent to `ctx.http`; only the display copy is
 * redacted. If the URL cannot even be parsed, no fragment of it is used — a fixed placeholder stands in instead,
 * because guessing at redaction on unparseable input is how a credential slips through.
 */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return '<unparseable url>';
  }
}

/**
 * One authenticated, read-only GET. §32 rule 12: the token reaches the `Authorization` header and nothing else —
 * never the detail, never the remediation, never a log line. Any URL that reaches a finding field goes through
 * `redactUrl` first, so a credential embedded in the configured URL cannot reach one either.
 *
 * Nothing here may throw past `run()`: DNS failure, a refused connection, a TLS error and a timeout are all the
 * normal shape of "this environment cannot reach the provider", not a bug in janus doctor, so `ctx.http`'s
 * contract (report failure in the result, never throw) is trusted but the URL parsing above is still guarded.
 */
async function reachability(input: ReachabilityInput): Promise<DoctorObservation> {
  const { ctx, id, title, system, url, tokenEnv } = input;
  const safeUrl = redactUrl(url);
  const token = ctx.env[tokenEnv];
  if (token === undefined || token.trim() === '') {
    return skipped(
      id,
      title,
      `cannot probe ${system}: ${tokenEnv} is not set`,
      `set ${tokenEnv} and re-run janus doctor; the tokens[${tokenEnv}] finding above reports the same thing`,
    );
  }
  let result;
  try {
    result = await ctx.http({ url, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, timeoutMs: PROBE_TIMEOUT_MS });
  } catch (error) {
    // `HttpProbe` implementations are expected to report failure in the result, not throw — but this check does
    // not simply trust that: a probe that violates its own contract must still produce a graceful `fail`, not an
    // exception that escapes into `runDoctor`'s generic handler and reports "this is a bug in janus doctor" for
    // what is, in fact, evidence of a real environment problem.
    const message = error instanceof Error ? error.message : String(error);
    return {
      id,
      title,
      status: 'fail',
      detail: `probing ${system} at ${safeUrl} threw instead of returning a result: ${message}`,
      remediation: `check the URL in .janus/config.yaml and your network: ${system} is reachable only from the work network (§33)`,
    };
  }
  if (result.ok) {
    return { id, title, status: 'pass', detail: `${system} answered ${String(result.status)} at ${safeUrl}`, remediation: null };
  }
  if (result.status === 401 || result.status === 403) {
    return {
      id,
      title,
      status: 'fail',
      detail: `${system} answered ${String(result.status)} at ${safeUrl}: the token was rejected`,
      remediation: `check that ${tokenEnv} holds a current HTTP access token with read permission for ${system}`,
    };
  }
  if (result.status === null) {
    return {
      id,
      title,
      status: 'fail',
      detail: `${system} did not answer at ${safeUrl}: ${result.error ?? 'no response'}`,
      remediation: `check the URL in .janus/config.yaml and your network: ${system} is reachable only from the work network (§33)`,
    };
  }
  return {
    id,
    title,
    status: 'fail',
    detail: `${system} answered ${String(result.status)} at ${safeUrl}`,
    remediation: `check the URL in .janus/config.yaml; ${safeUrl} did not answer the way the ${system} REST API should`,
  };
}

export const ciReachabilityCheck: DoctorCheck = {
  id: 'provider.ci',
  title: 'the configured CI provider is reachable',
  run: async (ctx) => {
    if (ctx.config === null) return [skipped('provider.ci', ciReachabilityCheck.title, 'no config.yaml', NO_WORKSPACE)];
    const provider = ctx.config.workflow.ci_provider;
    if (provider !== 'teamcity') {
      return [
        skipped(
          'provider.ci',
          ciReachabilityCheck.title,
          `workflow.ci_provider is "${provider}", which reaches no network service`,
          'nothing to do; this probe applies when workflow.ci_provider is "teamcity"',
        ),
      ];
    }
    const base = (ctx.config.teamcity.url ?? '').replace(/\/+$/u, '');
    return [
      await reachability({
        ctx,
        id: 'provider.ci',
        title: ciReachabilityCheck.title,
        system: 'TeamCity',
        url: `${base}/app/rest/server`,
        tokenEnv: ctx.config.teamcity.token_env,
      }),
    ];
  },
};

export const scmReachabilityCheck: DoctorCheck = {
  id: 'provider.scm',
  title: 'the configured SCM provider is reachable',
  run: async (ctx) => {
    if (ctx.config === null) return [skipped('provider.scm', scmReachabilityCheck.title, 'no config.yaml', NO_WORKSPACE)];
    const provider = ctx.config.workflow.scm_provider;
    if (provider !== 'bitbucket-server') {
      return [
        skipped(
          'provider.scm',
          scmReachabilityCheck.title,
          `workflow.scm_provider is "${provider}", which reaches no network service`,
          'nothing to do; this probe applies when workflow.scm_provider is "bitbucket-server"',
        ),
      ];
    }
    const base = (ctx.config.bitbucket.url ?? '').replace(/\/+$/u, '');
    return [
      await reachability({
        ctx,
        id: 'provider.scm',
        title: scmReachabilityCheck.title,
        system: 'Bitbucket Server',
        url: `${base}/rest/api/1.0/projects?limit=1`,
        tokenEnv: ctx.config.bitbucket.token_env,
      }),
    ];
  },
};
