/**
 * Shared privacy-level vocabulary + pure selectability logic (permissions
 * overhaul U6/U7 UI). No I/O — safe to import from server and client components.
 *
 * The three internal privacy levels (v1), ordered least → most private by RANK:
 *   only_teammates (2) < only_participants (1) < only_me (0)
 * (a SMALLER rank = MORE private — mirrors the rank table in privacy-action.ts /
 * the DB floor trigger). The org "floor" is the MOST-private level a normal owner
 * may pick; levels more private than the floor are off-limits to non-admins.
 */

export const PRIVACY_LEVELS = ['only_me', 'only_participants', 'only_teammates'] as const;
export type PrivacyLevel = (typeof PRIVACY_LEVELS)[number];

/** Smaller rank = more private. Matches privacy-action.ts and the DB trigger. */
export const PRIVACY_RANK: Record<PrivacyLevel, number> = {
  only_me: 0,
  only_participants: 1,
  only_teammates: 2,
};

/** Short label shown in pickers / badges. */
export const PRIVACY_LABEL: Record<PrivacyLevel, string> = {
  only_me: 'Only me',
  only_participants: 'Only participants',
  only_teammates: 'Only teammates (workspace)',
};

/** One-line description of who can see a meeting at each level. */
export const PRIVACY_DESCRIPTION: Record<PrivacyLevel, string> = {
  only_me: 'Only you can open this meeting.',
  only_participants: 'Everyone who attended this meeting can open it.',
  only_teammates: 'Everyone in your workspace can open this meeting.',
};

export function isPrivacyLevel(v: string): v is PrivacyLevel {
  return (PRIVACY_LEVELS as readonly string[]).includes(v);
}

/** Coerce an unknown stored value to a PrivacyLevel, defaulting to only_teammates
 *  (the org default / library-by-default level) for anything unexpected. */
export function toPrivacyLevel(v: string | null | undefined): PrivacyLevel {
  return v !== null && v !== undefined && isPrivacyLevel(v) ? v : 'only_teammates';
}

export interface PrivacyOption {
  level: PrivacyLevel;
  label: string;
  description: string;
  /** False → the viewer may not pick this level (rendered disabled). */
  selectable: boolean;
}

/**
 * Which privacy levels can THIS viewer pick for a meeting, given the org floor?
 *
 * Pure decision (no I/O), the UI mirror of the DB floor trigger (KTD7):
 *   - An ADMIN (manager OR super_admin) may pick ANY level — admin override is
 *     floor-EXEMPT (R12). Every option is selectable.
 *   - A non-admin OWNER is floor-bound: a level MORE private than the floor
 *     (rank < floor rank) is NOT selectable.
 *
 * The current level is always included as selectable even if it is below the
 * floor (an admin override may have left it there) so the picker can faithfully
 * show + retain the meeting's actual level without forcing a change.
 *
 * Callers decide whether to even render a picker: a non-owner non-admin gets a
 * read-only badge (see `canEditPrivacy`).
 */
export function privacyOptionsFor(args: {
  isAdmin: boolean;
  floor: PrivacyLevel;
  currentLevel: PrivacyLevel;
}): PrivacyOption[] {
  const { isAdmin, floor, currentLevel } = args;
  const floorRank = PRIVACY_RANK[floor];
  return PRIVACY_LEVELS.map((level) => {
    const selectable =
      isAdmin || level === currentLevel || PRIVACY_RANK[level] >= floorRank;
    return {
      level,
      label: PRIVACY_LABEL[level],
      description: PRIVACY_DESCRIPTION[level],
      selectable,
    };
  });
}

/** May this viewer edit the meeting's privacy at all? Owner OR admin. A non-owner
 *  non-admin sees the level read-only (no picker). */
export function canEditPrivacy(args: { isOwner: boolean; isAdmin: boolean }): boolean {
  return args.isOwner || args.isAdmin;
}
