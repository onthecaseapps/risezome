import { Sidebar } from './sidebar.js';
import { WsClient } from './ws-client.js';
import type { ServerMessage } from './types.js';

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

if (typeof window !== 'undefined' && window.UPWELL_BOOTSTRAP !== undefined) {
  bootstrap(window.document, window.UPWELL_BOOTSTRAP);
}
