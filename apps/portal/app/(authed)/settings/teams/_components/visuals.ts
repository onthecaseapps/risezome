/**
 * Deterministic visual tokens shared across the Teams & members surface — team
 * dot colors and avatar initials/colors. Pure (no I/O), so both the server page
 * and client components can derive identical colors from the same seed without
 * persisting a color column.
 */

/** djb2-ish string hash → unsigned 32-bit. Stable across renders + reloads. */
function hash(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h;
}

/** Avatar background colors — initials on a deterministic tint. */
const AVATAR_COLORS = [
  'bg-rose-500',
  'bg-amber-500',
  'bg-emerald-500',
  'bg-sky-500',
  'bg-violet-500',
  'bg-fuchsia-500',
  'bg-teal-500',
  'bg-indigo-500',
];

export function avatarColor(name: string): string {
  return AVATAR_COLORS[hash(name) % AVATAR_COLORS.length]!;
}

export function avatarInitial(name: string): string {
  const t = name.trim();
  return t.length > 0 ? t[0]!.toUpperCase() : '?';
}

/**
 * Per-team dot color. Seeded by the team id so a team keeps the same color
 * everywhere it appears (rail, member pills, detail header). Returned as a `bg-*`
 * class for a filled dot.
 */
const TEAM_DOT_COLORS = [
  'bg-indigo-500',
  'bg-emerald-500',
  'bg-amber-500',
  'bg-sky-500',
  'bg-rose-500',
  'bg-violet-500',
  'bg-teal-500',
  'bg-fuchsia-500',
];

export function teamDotColor(teamId: string): string {
  return TEAM_DOT_COLORS[hash(teamId) % TEAM_DOT_COLORS.length]!;
}
