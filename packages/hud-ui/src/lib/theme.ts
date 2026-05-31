/**
 * Theme persistence key. Namespaced so cohabiting HUDs sharing an origin
 * don't clash.
 */
export const THEME_STORAGE_KEY = 'upwell:theme';

/**
 * Tri-state theme preference. 'system' honors OS prefers-color-scheme
 * AND listens for changes (the toggle's useEffect installs a media
 * query listener while in 'system' mode).
 */
export type ThemePreference = 'light' | 'dark' | 'system';

/**
 * The inline `<script>` content executed BEFORE React hydrates so the
 * .dark class is applied to <html> in time to prevent a flash of the
 * wrong theme.
 *
 * Resolution order:
 *   1. localStorage[upwell:theme] → 'light' | 'dark' | 'system'
 *   2. If 'system' (or absent/invalid): matchMedia('(prefers-color-scheme: dark)')
 *   3. If matchMedia unavailable: default to light
 *
 * Must NOT throw under any condition — it runs before React, and a
 * throw leaves the page broken. Wraps localStorage in try/catch (Safari
 * private mode and disabled-storage origins throw on access).
 *
 * Authored as a single string so its SHA-256 hash is stable across
 * builds — that hash goes in the U5 CSP allow-list.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var k='${THEME_STORAGE_KEY}';var s=null;try{s=window.localStorage&&window.localStorage.getItem(k);}catch(e){}var pref=(s==='dark'||s==='light'||s==='system')?s:'system';var dark=false;if(pref==='dark'){dark=true;}else if(pref==='light'){dark=false;}else if(window.matchMedia){try{dark=window.matchMedia('(prefers-color-scheme: dark)').matches;}catch(e){}}if(dark){document.documentElement.classList.add('dark');}else{document.documentElement.classList.remove('dark');}}catch(e){}})();`;

/**
 * Read the stored preference. Returns 'system' as the default when no
 * preference has been set yet (matches the init script's behavior).
 * Pure client-side; throws never (best-effort).
 */
export function readStoredTheme(): ThemePreference {
  if (typeof window === 'undefined') return 'system';
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  } catch {
    // tolerate storage failures
  }
  return 'system';
}

/**
 * Persist a preference. Best-effort; swallows storage failures.
 */
export function writeStoredTheme(pref: ThemePreference): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    // tolerate storage failures (Safari private mode, quota exceeded)
  }
}

/**
 * Resolve a preference to the effective theme that should be applied
 * right now. 'system' reads prefers-color-scheme; everything else maps
 * 1:1.
 */
export function resolveEffectiveTheme(pref: ThemePreference): 'light' | 'dark' {
  if (pref === 'light' || pref === 'dark') return pref;
  if (typeof window === 'undefined') return 'light';
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/**
 * Apply a preference to the document by toggling the .dark class on
 * <html>. Idempotent.
 */
export function applyTheme(pref: ThemePreference): void {
  if (typeof document === 'undefined') return;
  const effective = resolveEffectiveTheme(pref);
  document.documentElement.classList.toggle('dark', effective === 'dark');
}
