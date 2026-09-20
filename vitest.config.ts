import { configDefaults, defineConfig } from 'vitest/config';

/** Hermetic git identity with no user or system config, shared by both test projects. */
const gitEnv = {
  GIT_AUTHOR_NAME: 'Janus Test',
  GIT_AUTHOR_EMAIL: 'janus@test.invalid',
  GIT_COMMITTER_NAME: 'Janus Test',
  GIT_COMMITTER_EMAIL: 'janus@test.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/**/*.test.ts'],
          exclude: [...configDefaults.exclude, 'tests/integration/**'],
          env: { ...gitEnv },
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          // Each harness clones four real git repositories; a cold CI runner is slow.
          testTimeout: 120_000,
          hookTimeout: 120_000,
          env: { ...gitEnv, JANUS_TEST_LANE: 'integration' },
        },
      },
    ],
  },
});
