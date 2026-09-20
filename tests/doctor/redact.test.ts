import { describe, expect, it } from 'vitest';
import { redactCredentials, redactUrl } from '../../src/doctor/redact.js';

// None of the strings below is a realistic credential shape: they are obvious placeholders, there to prove
// redaction happened, never to look like something worth copying (§32 rule 12).
const USERINFO = 'PLACEHOLDER-USERINFO';
const QUERY = 'PLACEHOLDER-QUERY';
const FRAGMENT = 'PLACEHOLDER-FRAGMENT';

describe('redactUrl', () => {
  it('strips userinfo and says so nowhere it could be mistaken for the real host', () => {
    expect(redactUrl(`https://svcuser:${USERINFO}@bitbucket.example.internal/scm/fe/state.git`)).toBe(
      'https://bitbucket.example.internal/scm/fe/state.git',
    );
  });

  it('drops the whole query string, not just credential-named params, and says it did', () => {
    const redacted = redactUrl(`https://host.example.internal/a?access_token=${QUERY}&page=2`);
    expect(redacted).toBe('https://host.example.internal/a (query string redacted)');
    expect(redacted).not.toContain('page=2');
  });

  it('drops the fragment too, without claiming a query string was removed', () => {
    // A fragment is never transmitted, so it carries nothing diagnostic — but it can still carry a credential
    // into a finding, and `redactCredentials`'s query regex anchors on `[?&]`, so it would not catch one.
    const redacted = redactUrl(`https://host.example.internal/a#token=${FRAGMENT}`);
    expect(redacted).toBe('https://host.example.internal/a');
    expect(redacted).not.toContain(FRAGMENT);
  });

  it('drops a fragment and a query string together', () => {
    const redacted = redactUrl(`https://svcuser:${USERINFO}@host.example.internal/a?key=${QUERY}#token=${FRAGMENT}`);
    expect(redacted).toBe('https://host.example.internal/a (query string redacted)');
    expect(redacted).not.toContain(USERINFO);
    expect(redacted).not.toContain(QUERY);
    expect(redacted).not.toContain(FRAGMENT);
  });

  it('yields a fixed placeholder for an unparseable URL, never a fragment of the input', () => {
    expect(redactUrl(`not a url ${USERINFO}`)).toBe('<unparseable url>');
  });
});

describe('redactCredentials', () => {
  it('blanks userinfo in free text', () => {
    expect(redactCredentials(`fetch failed for https://svcuser:${USERINFO}@host.example.internal/a`)).toBe(
      'fetch failed for https://<redacted>@host.example.internal/a',
    );
  });

  it('blanks the value of a credential-named query parameter, case-insensitively', () => {
    const redacted = redactCredentials(`GET https://host.example.internal/a?Access_Token=${QUERY}&page=2 failed`);
    expect(redacted).not.toContain(QUERY);
    expect(redacted).toContain('page=2');
  });

  it('leaves text with nothing credential-shaped in it alone', () => {
    expect(redactCredentials('ENOENT: no such file or directory')).toBe('ENOENT: no such file or directory');
  });
});
