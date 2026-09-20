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
 * Query parameter names that commonly carry a credential when a provider URL uses query-string auth instead of
 * (or alongside) userinfo or a bearer header. Not exhaustive — see `redactCredentials` below.
 */
const CREDENTIAL_QUERY_PARAMS = ['token', 'access_token', 'api_key', 'apikey', 'key', 'password', 'secret', 'auth'];
const CREDENTIAL_QUERY_PARAM_RE = new RegExp(`([?&](?:${CREDENTIAL_QUERY_PARAMS.join('|')})=)[^&\\s]*`, 'giu');

/**
 * The structural redaction: parses `url`, strips userinfo **and the entire query string**, and serialises what's
 * left. This is the guarantee for the URL the check itself builds and sends to `ctx.http` — a real URL can be
 * parsed exactly, so there is no credential-shape to guess at and no denylist to maintain. Dropping the whole
 * query string, not just known credential params, is deliberate: nothing diagnostically valuable is lost from a
 * reachability probe's detail line by doing so (the host and path are what identify what was probed), and a
 * denylist of query keys is exactly the kind of guess that a future auth scheme can slip past. When a query
 * string was removed, the redacted form says so explicitly, so an operator reading the report isn't left thinking
 * the probe hit a bare path it didn't. An unparseable URL yields a fixed placeholder, not any fragment of the
 * input — guessing at redaction on unparseable input is how a credential slips through.
 */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const hadQuery = parsed.search !== '';
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    const base = parsed.toString();
    return hadQuery ? `${base} (query string redacted)` : base;
  } catch {
    return '<unparseable url>';
  }
}

/**
 * The best-effort redaction, for free text that did not come from parsing a URL: `result.error` and a caught
 * error's `message`. §32 rule 12: a configured provider URL can legitimately embed credentials, and it is not
 * only the URL the check builds itself that can carry one into a finding — `fetchProbe`'s real `fetch()` call
 * rejects a credentialed URL at Request-construction time, before any network I/O, with an error message that
 * embeds the whole raw URL verbatim, userinfo and query string both
 * (`TypeError: Request cannot be constructed from a URL that includes credentials: https://user:pass@host/...`).
 * That message comes back as `result.error` — a *returned* value, not a thrown one — so a `try/catch` around the
 * probe call never sees it, and for a userinfo-credentialed URL it is the *only* branch that can ever reach it
 * (`pass`, `401`, `403` and the generic non-2xx branches all require a response, which `fetch()` never attempts to
 * get for such a URL) — but a *query-string* credential survives into an ordinary `pass`, because `fetch()` has no
 * objection to those and the request succeeds.
 *
 * Unlike `redactUrl`, this text cannot be parsed structurally — it strips the same `scheme://user:pass@` shape
 * `GitError` in `src/git/run.ts` already redacts from arbitrary git args, and additionally blanks the *value* of
 * any query parameter named like a credential (case-insensitive), but it is best-effort: it catches the common
 * shapes, it does not guarantee coverage of every way a credential could appear in free text. The structural
 * guarantee lives in `redactUrl`, which is why every URL that reaches a finding field goes through that first.
 */
function redactCredentials(text: string): string {
  return text.replace(/(:\/\/)[^/@\s]+@/gu, '$1<redacted>@').replace(CREDENTIAL_QUERY_PARAM_RE, '$1<redacted>');
}

/**
 * One authenticated, read-only GET. §32 rule 12: the token reaches the `Authorization` header and nothing else —
 * never the detail, never the remediation, never a log line. Every externally-derived string that reaches a
 * finding field is redacted before it does: the probed URL through `redactUrl` (structural — userinfo and the
 * whole query string), and free text (`result.error`, a caught error's `message`) through `redactCredentials`
 * (best-effort).
 *
 * Nothing here may throw past `run()`: DNS failure, a refused connection, a TLS error and a timeout are all the
 * normal shape of "this environment cannot reach the provider", not a bug in janus doctor, so `ctx.http`'s
 * contract (report failure in the result, never throw) is trusted but the call is still guarded — a probe
 * implementation that violates its own contract must still produce a graceful `fail`, not an exception that
 * escapes into `runDoctor`'s generic handler.
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
      detail: `probing ${system} at ${safeUrl} threw instead of returning a result: ${redactCredentials(message)}`,
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
    // `result.error` is externally derived and may itself embed the raw, credentialed URL — most notably
    // `fetchProbe`'s real `fetch()` rejecting a credentialed URL at Request-construction time with a message that
    // quotes the whole URL back verbatim. It gets the same redaction as `safeUrl`, not a free pass because it
    // came from the probe result rather than from the check's own string-building.
    const safeError = result.error === null ? 'no response' : redactCredentials(result.error);
    return {
      id,
      title,
      status: 'fail',
      detail: `${system} did not answer at ${safeUrl}: ${safeError}`,
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
