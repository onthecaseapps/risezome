import { redirect } from 'next/navigation';

/**
 * Redirect stub: Teams & members moved under Settings to /settings/teams.
 * Kept so old bookmarks and external links to /teams still resolve.
 */
export default function Page() {
  redirect('/settings/teams');
}
