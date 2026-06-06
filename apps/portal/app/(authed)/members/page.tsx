import { redirect } from 'next/navigation';

/**
 * `/members` consolidated into the unified "Teams & members" surface at `/teams`.
 * Kept as a permanent redirect so old links — and the invite-accept "back to
 * members" path — still land on the live page.
 */
export default function MembersPage(): never {
  redirect('/teams');
}
