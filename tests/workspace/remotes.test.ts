import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/config/errors.js';
import { goalSchema } from '../../src/config/goal-schema.js';
import { parseConfig } from '../../src/config/load-config.js';
import { repoCloneUrl, stateBranchName, stateRemote } from '../../src/workspace/remotes.js';
import { validGoal } from '../fixtures/valid-goal.js';

const fakeProviders = { workflow: { ci_provider: 'fake', scm_provider: 'fake' } };

describe('repoCloneUrl', () => {
  it('prefers an explicit clone_url', () => {
    const goal = goalSchema.parse({
      ...validGoal,
      repos: [{ ...validGoal.repos[0], clone_url: '/tmp/ui-kit.git' }, ...validGoal.repos.slice(1)],
    });
    const config = parseConfig(fakeProviders, 'config.yaml');
    const repo = goal.repos[0];
    if (!repo) throw new Error('fixture has no repos');
    expect(repoCloneUrl(repo, config)).toBe('/tmp/ui-kit.git');
  });

  it('renders the bitbucket template with a lowercase project key', () => {
    const goal = goalSchema.parse(validGoal);
    const config = parseConfig({ ...fakeProviders, bitbucket: { url: 'https://bb.example.internal/' } }, 'config.yaml');
    const repo = goal.repos[0];
    if (!repo) throw new Error('fixture has no repos');
    expect(repoCloneUrl(repo, config)).toBe('https://bb.example.internal/scm/fe/ui-kit.git');
  });

  it('treats a literal $ in bitbucket.url as literal, not a replacement pattern', () => {
    // "$&" is JS String.replace's "insert the whole match" token; if renderTemplate passes
    // values straight as the replacement argument, this reappears as the {url} placeholder
    // it just replaced instead of being carried through literally.
    const goal = goalSchema.parse(validGoal);
    const config = parseConfig({ ...fakeProviders, bitbucket: { url: 'https://bb.example.internal/$&prefix' } }, 'config.yaml');
    const repo = goal.repos[0];
    if (!repo) throw new Error('fixture has no repos');
    expect(repoCloneUrl(repo, config)).toBe('https://bb.example.internal/$&prefix/scm/fe/ui-kit.git');
  });

  it('fails clearly when neither clone_url nor bitbucket.url exists', () => {
    const goal = goalSchema.parse(validGoal);
    const config = parseConfig(fakeProviders, 'config.yaml');
    const repo = goal.repos[0];
    if (!repo) throw new Error('fixture has no repos');
    expect(() => repoCloneUrl(repo, config)).toThrowError(ConfigError);
    expect(() => repoCloneUrl(repo, config)).toThrowError(/repos\.ui-kit\.clone_url: required/);
  });
});

describe('stateRemote', () => {
  it('uses state.clone_url when configured', () => {
    const goal = goalSchema.parse(validGoal);
    const config = parseConfig({ ...fakeProviders, state: { clone_url: '/tmp/state.git' } }, 'config.yaml');
    expect(stateRemote(goal, config)).toEqual({ url: '/tmp/state.git', remoteName: 'state-repo' });
  });

  it('renders state.repo through the bitbucket template', () => {
    const goal = goalSchema.parse(validGoal);
    const config = parseConfig(
      { ...fakeProviders, bitbucket: { url: 'https://bb.example.internal' }, state: { repo: { project: 'FE', slug: 'janus-state' } } },
      'config.yaml',
    );
    expect(stateRemote(goal, config)).toEqual({ url: 'https://bb.example.internal/scm/fe/janus-state.git', remoteName: 'state-repo' });
  });

  it('falls back to the first repo of the goal', () => {
    const goal = goalSchema.parse({
      ...validGoal,
      repos: [{ ...validGoal.repos[0], clone_url: '/tmp/ui-kit.git' }, ...validGoal.repos.slice(1)],
    });
    const config = parseConfig(fakeProviders, 'config.yaml');
    expect(stateRemote(goal, config)).toEqual({ url: '/tmp/ui-kit.git', remoteName: 'ui-kit' });
  });
});

describe('stateBranchName', () => {
  it('prefixes the goal id', () => {
    expect(stateBranchName('angular-15-to-16')).toBe('janus/angular-15-to-16');
  });
});
