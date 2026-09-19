import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    env: {
      GIT_AUTHOR_NAME: 'Janus Test',
      GIT_AUTHOR_EMAIL: 'janus@test.invalid',
      GIT_COMMITTER_NAME: 'Janus Test',
      GIT_COMMITTER_EMAIL: 'janus@test.invalid',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  },
});
