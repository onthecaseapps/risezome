/**
 * Theme persistence key. Namespaced so cohabiting HUDs sharing an origin
 * don't clash.
 */
export const THEME_STORAGE_KEY = 'upwell:theme';

/**
 * The inline `<script>` content executed BEFORE React hydrates so the
 * .dark class is applied to <html> in time to prevent a flash of the
 * wrong theme.
 *
 * Must NOT throw under any condition — it runs before React, and a throw
 * leaves the page broken. Wraps localStorage in try/catch (Safari private
 * mode and disabled-storage origins throw on access). Falls back to OS
 * preference via matchMedia; if matchMedia is unavailable, defaults to light.
 *
 * Authored as a single string so its SHA-256 hash is stable across builds
 * — that hash goes in the U5 CSP allow-list.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var k='${THEME_STORAGE_KEY}';var s=null;try{s=window.localStorage&&window.localStorage.getItem(k);}catch(e){}var m='light';if(s==='dark'||s==='light'){m=s;}else if(window.matchMedia){try{m=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}catch(e){}}if(m==='dark'){document.documentElement.classList.add('dark');}}catch(e){}})();`;
