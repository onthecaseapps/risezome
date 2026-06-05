/**
 * Pure validation + normalization helpers for team create/rename (U7).
 *
 * Kept side-effect-free (no next/headers, no db) so they can be unit-tested
 * directly and shared between the server actions and any client-side hints.
 * The server actions are the real authority; these are the shape rules both
 * sides agree on.
 */

/** Max team-name length. Mirrors the org-name 100-char cap in onboarding. */
export const TEAM_NAME_MAX = 60;

/** A kebab-case slug: lowercase alphanumerics in dot-free, dash-separated words.
 *  e.g. "platform", "growth-eng", "q3-2026". No leading/trailing/double dashes. */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type NameCheck = { ok: true; value: string } | { ok: false; error: string };

/** Validate + trim a team name. */
export function validateTeamName(raw: unknown): NameCheck {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (name.length === 0) return { ok: false, error: 'empty_name' };
  if (name.length > TEAM_NAME_MAX) return { ok: false, error: 'name_too_long' };
  return { ok: true, value: name };
}

/**
 * Derive a kebab-case slug from arbitrary text (e.g. a team name): lowercase,
 * non-alphanumerics → single dashes, trimmed of edge dashes. Used to suggest a
 * slug from the name so a creator never has to hand-type one.
 */
export function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

/**
 * Validate a slug. If `raw` is empty, fall back to slugifying `nameForFallback`
 * (so the create form can omit the slug field and derive it from the name).
 */
export function validateTeamSlug(raw: unknown, nameForFallback = ''): NameCheck {
  let slug = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (slug.length === 0) slug = slugify(nameForFallback);
  if (slug.length === 0) return { ok: false, error: 'empty_slug' };
  if (slug.length > 50) return { ok: false, error: 'slug_too_long' };
  if (!SLUG_RE.test(slug)) return { ok: false, error: 'invalid_slug' };
  return { ok: true, value: slug };
}

/** True if a Postgres error message reflects the unique(org_id, slug) violation. */
export function isDuplicateSlugError(message: string): boolean {
  // PostgREST surfaces the unique constraint by name; match either the code-ish
  // "duplicate key" text or the named constraint from the migration.
  return (
    message.includes('teams_org_id_slug_key') ||
    (message.includes('duplicate key') && message.includes('slug')) ||
    message.toLowerCase().includes('unique')
  );
}
