/**
 * §32 rule 12 redaction for doctor findings. Two functions with deliberately distinct roles, kept separate:
 * `redactUrl` is the **structural guarantee** for a string that is known to be a URL, and `redactCredentials` is
 * the **best-effort** pass for free text that cannot be parsed. Every URL that reaches a finding field goes
 * through `redactUrl` first; free text that merely *may* embed one goes through `redactCredentials`. They are not
 * interchangeable and must not be merged: merging them would either weaken the structural guarantee to a denylist
 * or apply a parse to text that is not a URL.
 *
 * They live here, rather than in the one check that first needed them, because more than one check builds a
 * finding out of a configured URL: `provider.ci`/`provider.scm` probe `teamcity.url`/`bitbucket.url`, and
 * `state.branch_spec` reports the state remote resolved from `state.clone_url` — which is an ordinary place for a
 * `https://user:<pat>@host/...` clone URL to be configured, and whose finding is a `pass`, so it prints on every
 * healthy run.
 */

/**
 * Query parameter names that commonly carry a credential when a provider URL uses query-string auth instead of
 * (or alongside) userinfo or a bearer header. Not exhaustive — see `redactCredentials` below.
 */
const CREDENTIAL_QUERY_PARAMS = ['token', 'access_token', 'api_key', 'apikey', 'key', 'password', 'secret', 'auth'];
const CREDENTIAL_QUERY_PARAM_RE = new RegExp(`([?&](?:${CREDENTIAL_QUERY_PARAMS.join('|')})=)[^&\\s]*`, 'giu');

/**
 * The structural redaction: parses `url`, strips userinfo, **the entire query string and the fragment**, and
 * serialises what's left. This is the guarantee for any URL a finding names — a real URL can be parsed exactly, so
 * there is no credential-shape to guess at and no denylist to maintain. Dropping the whole query string, not just
 * known credential params, is deliberate: nothing diagnostically valuable is lost from a finding's detail line by
 * doing so (the host and path are what identify what was probed or configured), and a denylist of query keys is
 * exactly the kind of guess that a future auth scheme can slip past. The fragment goes for the same reason: it is
 * never transmitted to the server, so it carries nothing diagnostic, but a `#token=...` in a configured URL would
 * otherwise survive into a finding — and `redactCredentials`'s query regex anchors on `[?&]`, so it would not
 * catch it either. When a query string was removed, the redacted form says so explicitly, so an operator reading
 * the report isn't left thinking the probe hit a bare path it didn't; a fragment needs no such note, because it
 * was never part of what the server saw. An unparseable URL yields a fixed placeholder, not any fragment of the
 * input — guessing at redaction on unparseable input is how a credential slips through.
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const hadQuery = parsed.search !== '';
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    const base = parsed.toString();
    return hadQuery ? `${base} (query string redacted)` : base;
  } catch {
    return '<unparseable url>';
  }
}

/**
 * The best-effort redaction, for free text that did not come from parsing a URL: a probe's `result.error`, a
 * caught error's `message`. §32 rule 12: a configured provider URL can legitimately embed credentials, and it is
 * not only the URL a check builds itself that can carry one into a finding — `fetchProbe`'s real `fetch()` call
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
export function redactCredentials(text: string): string {
  return text.replace(/(:\/\/)[^/@\s]+@/gu, '$1<redacted>@').replace(CREDENTIAL_QUERY_PARAM_RE, '$1<redacted>');
}
