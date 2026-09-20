import { describe, expect, it } from 'vitest';

describe('integration lane', () => {
  it('is collected only by the integration project and inherits the hermetic git environment', () => {
    expect(process.env['JANUS_TEST_LANE']).toBe('integration');
    expect(process.env['GIT_CONFIG_GLOBAL']).toBe('/dev/null');
    expect(process.env['GIT_CONFIG_NOSYSTEM']).toBe('1');
    expect(process.env['GIT_COMMITTER_EMAIL']).toBe('janus@test.invalid');
  });
});
