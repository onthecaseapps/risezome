import { describe, it, expect } from 'vitest';

// U1 smoke test — confirms the test runner is wired. U3/U4 replace this
// with the real behavior tests per the migration manifest.
describe('hud-next smoke', () => {
  it('vitest runs', () => {
    expect(1 + 1).toBe(2);
  });
});
