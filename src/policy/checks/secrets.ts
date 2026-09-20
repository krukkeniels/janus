import { addedLines } from '../diff.js';
import { violation } from '../types.js';
import type { PolicyCheck, PolicyFinding } from '../types.js';

export interface SecretPattern {
  label: string;
  re: RegExp;
}

/**
 * Spec §14's "secrets — common token patterns" row.
 *
 * Deliberately shape-based, not entropy-based: an entropy heuristic on an `ng update` diff flags minified
 * bundles and lockfile integrity hashes by the hundred, and a check whose output is mostly noise is a check
 * whose output gets skipped. §32 rule 12 makes a false negative recoverable (the AI checkpoint and the human
 * reviewer both see the diff) and a **leaked secret in evidence** unrecoverable, which is why the finding below
 * records the pattern label and the location and never the matched text.
 */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { label: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/u },
  { label: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/u },
  { label: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/u },
  { label: 'private key block', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/u },
  { label: 'JSON web token', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u },
  {
    label: 'credential-shaped assignment',
    re: /\b(?:token|password|secret|api[_-]?key|access[_-]?key)["']?\s*[:=]\s*["'][^"'\s]{12,}["']/iu,
  },
  { label: 'credentialed URL', re: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/iu },
];

/**
 * One finding per **line**, not per pattern: a line that trips three patterns is one place to look, and
 * repeating it three times in the evidence file only makes the report harder to act on.
 */
export const secretsCheck: PolicyCheck = {
  id: 'secrets.detected',
  title: 'no secret-shaped value was added',
  run: async (ctx) => {
    const findings: PolicyFinding[] = [];
    for (const file of ctx.analysis.files) {
      for (const line of addedLines(file)) {
        const matched = SECRET_PATTERNS.filter((pattern) => pattern.re.test(line.text));
        if (matched.length === 0) continue;
        findings.push(
          violation(
            'secrets.detected',
            `${file.path}:${line.line} adds a value matching ${matched.map((pattern) => pattern.label).join(', ')}; ` +
              'the value is not reproduced here (§32 rule 12)',
            { path: file.path, line: line.line },
          ),
        );
      }
    }
    return findings;
  },
};
