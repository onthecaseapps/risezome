import { Sidebar } from './sidebar.js';
import { WsClient } from './ws-client.js';
import type { ServerMessage } from './types.js';
import { renderIcon, type IconName } from './icons.js';

export interface BootstrapConfig {
  readonly wsUrl: string;
  readonly token: string;
}

declare global {
  interface Window {
    UPWELL_BOOTSTRAP?: BootstrapConfig;
  }
}

export function bootstrap(
  doc: Document,
  config: BootstrapConfig,
): { sidebar: Sidebar; ws: WsClient } {
  applyInitialTheme(doc);
  wireThemeToggle(doc);
  const streamEl = requireEl(doc, 'card-stream');
  const pinnedEl = requireEl(doc, 'pinned-section');
  const banner = requireEl(doc, 'connection-banner');
  const statusEl = requireEl(doc, 'meeting-status');

  const setMeetingMode = (mode: 'idle' | 'live'): void => {
    if (mode === 'live') {
      statusEl.textContent = 'LIVE';
      statusEl.classList.remove('status-idle');
      statusEl.classList.add('status-live');
    } else {
      statusEl.textContent = 'IDLE';
      statusEl.classList.remove('status-live');
      statusEl.classList.add('status-idle');
    }
  };

  const sidebar = new Sidebar({ streamEl, pinnedEl });

  const ws = new WsClient({
    url: config.wsUrl,
    token: config.token,
    onMessage: (msg: ServerMessage) => {
      switch (msg.type) {
        case 'card':
          sidebar.renderCard(msg.card);
          break;
        case 'cardUpdated':
          sidebar.updateCard(msg.update);
          break;
        case 'cardRetracted':
          sidebar.retractCard(msg.retracted);
          break;
        case 'gap':
          sidebar.renderGap(msg.gap);
          break;
        case 'meetingStarted':
          setMeetingMode('live');
          break;
        case 'meetingEnded':
          setMeetingMode('idle');
          break;
        case 'status':
          setMeetingMode(msg.mode === 'idle' ? 'idle' : 'live');
          break;
        case 'synthesisStart':
          sidebar.renderSynthesisStart({
            synthesisId: msg.synthesisId,
            sourceCardIds: msg.sourceCardIds,
            traceId: msg.traceId,
          });
          break;
        case 'synthesisDelta':
          sidebar.appendSynthesisDelta({
            synthesisId: msg.synthesisId,
            delta: msg.delta,
          });
          break;
        case 'synthesisDone':
          sidebar.finalizeSynthesis({
            synthesisId: msg.synthesisId,
            stopReason: msg.stopReason,
            citations: msg.citations,
            usage: msg.usage,
            ttftMs: msg.ttftMs,
            latencyMs: msg.latencyMs,
          });
          break;
        case 'synthesisError':
          // Both refusal and genuine errors land here. Single removal
          // path: drop the synthesis card and let raw cards stand alone.
          sidebar.removeSynthesis(msg.synthesisId);
          break;
        case 'synthesisRetracted':
          sidebar.retractSynthesis({
            synthesisId: msg.synthesisId,
            reason: msg.reason,
          });
          break;
        default:
          break;
      }
    },
    onStatus: (s) => {
      if (s === 'open') {
        banner.classList.add('hidden');
      } else if (s === 'disconnected') {
        banner.textContent = 'Disconnected — reconnecting…';
        banner.classList.remove('hidden');
      } else {
        banner.textContent = 'Connecting…';
        banner.classList.remove('hidden');
      }
    },
  });

  ws.start();
  return { sidebar, ws };
}

function requireEl(doc: Document, id: string): HTMLElement {
  const el = doc.getElementById(id);
  if (el === null) throw new Error(`HUD bootstrap: missing #${id}`);
  return el;
}

// Applies the `.dark` class to <html> based on the stored override (if any)
// or the OS preference. Tailwind v4's @custom-variant dark scopes every
// dark: utility against this class, and the existing CSS variables also
// flip on :root.dark — so a single class toggle re-themes the whole HUD.
//
// Storage key intentionally namespaced ('upwell:theme') so cohabiting HUDs
// or browser-shared origins don't clash.
export const THEME_STORAGE_KEY = 'upwell:theme';

function applyInitialTheme(doc: Document): void {
  const win = doc.defaultView;
  let mode: 'light' | 'dark';
  const stored = win?.localStorage?.getItem(THEME_STORAGE_KEY);
  if (stored === 'light' || stored === 'dark') {
    mode = stored;
  } else {
    const prefersDark = win?.matchMedia?.('(prefers-color-scheme: dark)').matches === true;
    mode = prefersDark ? 'dark' : 'light';
  }
  doc.documentElement.classList.toggle('dark', mode === 'dark');
  updateThemeIcon(doc, mode);
}

// Wires the header toggle button so each click flips the .dark class on
// <html> and persists the choice under upwell:theme. Subsequent loads
// honor the persisted value over the OS preference (handled in
// applyInitialTheme).
function wireThemeToggle(doc: Document): void {
  const btn = doc.getElementById('theme-toggle');
  if (btn === null) return;
  btn.addEventListener('click', () => {
    const isDark = doc.documentElement.classList.toggle('dark');
    const next: 'light' | 'dark' = isDark ? 'dark' : 'light';
    doc.defaultView?.localStorage?.setItem(THEME_STORAGE_KEY, next);
    updateThemeIcon(doc, next);
  });
}

function updateThemeIcon(doc: Document, mode: 'light' | 'dark'): void {
  const slot = doc.querySelector<HTMLElement>('#theme-toggle .theme-toggle-icon');
  if (slot === null) return;
  // Sun glyph when light is active (click → goes dark); moon when dark is
  // active. Render fresh each time so the SVG fully replaces the prior icon
  // instead of leaking attributes from the previous render.
  const name: IconName = mode === 'dark' ? 'moon' : 'sun';
  slot.replaceChildren(
    renderIcon(doc, name, { size: '14px', ariaLabel: mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode' }),
  );
}

if (typeof window !== 'undefined' && window.UPWELL_BOOTSTRAP !== undefined) {
  bootstrap(window.document, window.UPWELL_BOOTSTRAP);
}
