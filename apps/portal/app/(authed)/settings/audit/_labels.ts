/** Display label for a stored org role value. `manager` → "Admin" (KTD1),
 *  `super_admin` → "Super Admin". Shared by the audit-log detail formatter. */
export function roleLabel(role: string): string {
  switch (role) {
    case 'super_admin':
      return 'Super Admin';
    case 'manager':
      return 'Admin';
    default:
      return 'Member';
  }
}
