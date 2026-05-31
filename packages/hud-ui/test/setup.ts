import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// React Testing Library auto-cleans between tests under Jest but not under
// Vitest. Register the same hook explicitly so each test gets a fresh DOM.
afterEach(() => {
  cleanup();
});
