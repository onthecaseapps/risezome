/**
 * Canonical role vocabulary helpers (permissions overhaul; KTD1/KTD2). No I/O —
 * safe to import from server and client components.
 *
 * The stored role values are 'member' | 'manager' | 'super_admin', where the
 * stored `manager` IS the "Admin" tier (KTD1) and `super_admin` inherits all
 * admin powers plus the audited master key.
 */

/** Display label for a stored role value. `manager` → "Admin" (KTD1),
 *  `super_admin` → "Super Admin", anything else → "Member". */
export function roleLabel(role: string): 'Member' | 'Admin' | 'Super Admin' {
  switch (role) {
    case 'super_admin':
      return 'Super Admin';
    case 'manager':
      return 'Admin';
    default:
      return 'Member';
  }
}

/** Does this stored role carry ADMIN POWER? (manager OR super_admin — KTD2.)
 *  The canonical app-layer mirror of the DB `is_org_admin` gate. */
export function isAdminRole(role: string): boolean {
  return role === 'manager' || role === 'super_admin';
}
