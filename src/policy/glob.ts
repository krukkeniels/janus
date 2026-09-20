/**
 * The glob dialect `allowed_scope` (§12) and `policy.forbidden_paths` (§28) are written in — and no more than
 * that.
 *
 * Supported: `**` for any number of path segments, `*` for any run of characters inside one segment, `?` for one
 * such character. Not supported, deliberately: brace expansion, character classes, negation, `!`-prefixes.
 * Nothing in the spec's examples (`.teamcity/**`, `.github/**`, `src/**`, `projects/**`, `tsconfig*.json`,
 * `pnpm-lock.yaml`) needs them, and a half-implemented dialect is worse than a documented one: a plan author who
 * writes `src/**{,/}*.ts` and gets silent non-matching has manufactured a policy violation out of a typo.
 *
 * Patterns are always matched against a **repo-relative, forward-slash** path, exactly as git reports it.
 */
const CACHE = new Map<string, RegExp>();

const REGEX_METACHARACTERS = /[.+^${}()|[\]\\]/gu;

function compile(pattern: string): RegExp {
  const cached = CACHE.get(pattern);
  if (cached !== undefined) return cached;
  let source = '^';
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index];
    if (char === undefined) break;
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index += 2;
        if (pattern[index] === '/') {
          // `**/` — zero or more whole leading segments, so `**/*.spec.ts` matches `a.spec.ts` too.
          index += 1;
          source += '(?:[^/]+/)*';
        } else {
          // Trailing `**` — everything underneath, which is what `.teamcity/**` means.
          source += '.*';
        }
        continue;
      }
      source += '[^/]*';
      index += 1;
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      index += 1;
      continue;
    }
    source += char.replace(REGEX_METACHARACTERS, '\\$&');
    index += 1;
  }
  const compiled = new RegExp(`${source}$`, 'u');
  CACHE.set(pattern, compiled);
  return compiled;
}

export function matchesGlob(pattern: string, path: string): boolean {
  return compile(pattern).test(path);
}

export function matchesAnyGlob(patterns: readonly string[], path: string): boolean {
  return patterns.some((pattern) => matchesGlob(pattern, path));
}
