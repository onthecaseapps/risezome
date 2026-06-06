import { describe, it, expect } from 'vitest';
import { ENCRYPTED_COLUMNS } from '../src/inngest/lib/encrypted-columns';

describe('ENCRYPTED_COLUMNS registry', () => {
  it('registers the structured recap column so rotation/backfill cannot skip it', () => {
    const recapJson = ENCRYPTED_COLUMNS.find(
      (c) => c.table === 'meetings' && c.encColumn === 'recap_json_enc',
    );
    expect(recapJson).toBeDefined();
    expect(recapJson?.pk).toBe('meeting_id');
    expect(recapJson?.versionColumn).toBe('recap_json_key_version');
  });

  it('keeps the legacy markdown recap column registered alongside it', () => {
    const recapText = ENCRYPTED_COLUMNS.find(
      (c) => c.table === 'meetings' && c.encColumn === 'recap_text_enc',
    );
    expect(recapText?.versionColumn).toBe('recap_key_version');
  });
});
