// Dev-console browser client. Dumb renderer: ONE EventSource (/api/events)
// carries periodic state snapshots + every process's pre-rendered { html, level }
// log lines tagged by name. A single multiplexed connection avoids the browser's
// ~6-connections-per-host limit that starved per-pane streams during a long
// start-all. Control actions are plain fetch POSTs. No build step, no deps.

const CONSOLE = '__console__';

const procs = document.getElementById('procs');
const configForm = document.getElementById('config');
const tagInput = document.getElementById('tag');
const modeSelect = document.getElementById('mode');
const configStatus = document.getElementById('config-status');
const activityBar = document.getElementById('activity');
const activityText = document.getElementById('activity-text');

const cards = new Map(); // name -> { root, badge, pid, logs, atBottom }

async function api(path, method = 'GET', body) {
  const opts = { method };
  if (body !== undefined) {
    opts.headers = { 'content-type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  return res.json().catch(() => ({}));
}

// Append a pre-rendered log line to a pane, trimming history and autoscrolling.
function appendLog(pane, payload) {
  const line = document.createElement('span');
  line.className = `log-line ${payload.level ?? 'info'}`;
  line.innerHTML = `${payload.html ?? ''}\n`;
  pane.logs.appendChild(line);
  while (pane.logs.childElementCount > 2000) pane.logs.removeChild(pane.logs.firstChild);
  if (pane.atBottom) pane.logs.scrollTop = pane.logs.scrollHeight;
}

// Track whether a log pane is scrolled to the bottom (so new lines autoscroll
// only when the user hasn't scrolled up to read history).
function trackScroll(pane) {
  pane.logs.addEventListener('scroll', () => {
    pane.atBottom = pane.logs.scrollTop + pane.logs.clientHeight >= pane.logs.scrollHeight - 4;
  });
}

// ── Console panel (pinned at top): orchestration steps + tunnel setup ─────────
const consolePane = {
  root: document.getElementById('console-panel'),
  logs: document.getElementById('console-logs'),
  atBottom: true,
};
trackScroll(consolePane);

// ── Process panes ─────────────────────────────────────────────────────────────
function ensureCard(name) {
  let card = cards.get(name);
  if (card) return card;

  const root = document.createElement('section');
  root.className = 'proc';
  root.innerHTML = `
    <div class="proc-head">
      <span class="proc-name"></span>
      <span class="badge stopped">stopped</span>
      <span class="proc-pid"></span>
      <span class="proc-controls">
        <button data-act="start">start</button>
        <button data-act="stop">stop</button>
        <button data-act="restart">restart</button>
        <button data-expand title="Expand to full screen">⤢</button>
      </span>
    </div>
    <pre class="logs"></pre>`;
  root.querySelector('.proc-name').textContent = name;

  const badge = root.querySelector('.badge');
  const pid = root.querySelector('.proc-pid');
  const logs = root.querySelector('.logs');
  const expandBtn = root.querySelector('button[data-expand]');

  card = { root, badge, pid, logs, atBottom: true };

  root.querySelectorAll('button[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => {
      void api(`/api/proc/${encodeURIComponent(name)}/${btn.dataset.act}`, 'POST');
    });
  });
  expandBtn.addEventListener('click', () => toggleExpand(card, expandBtn));
  trackScroll(card);

  procs.appendChild(root);
  cards.set(name, card);
  return card;
}

function paintBadge(card, state) {
  card.badge.className = `badge ${state}`;
  card.badge.textContent = state;
}

function toggleExpand(card, btn) {
  const expanding = !card.root.classList.contains('expanded');
  // Only one card expanded at a time.
  for (const other of cards.values()) {
    other.root.classList.remove('expanded');
    const b = other.root.querySelector('button[data-expand]');
    if (b) {
      b.textContent = '⤢';
      b.title = 'Expand to full screen';
    }
  }
  if (expanding) {
    card.root.classList.add('expanded');
    btn.textContent = '⤡';
    btn.title = 'Collapse';
    card.logs.scrollTop = card.logs.scrollHeight;
  }
  document.body.classList.toggle('has-expanded', expanding);
}

document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  const open = [...cards.values()].find((c) => c.root.classList.contains('expanded'));
  if (open) toggleExpand(open, open.root.querySelector('button[data-expand]'));
});

function reconcileCards(names) {
  for (const [name, card] of cards) {
    if (!names.includes(name)) {
      card.root.remove();
      cards.delete(name);
    }
  }
}

function paintActivity(activity) {
  if (activity) {
    activityText.textContent = activity;
    activityBar.hidden = false;
  } else {
    activityBar.hidden = true;
  }
}

function applyState(state) {
  paintActivity(state.activity);
  const items = state.items ?? [];
  reconcileCards(items.map((i) => i.name));
  for (const item of items) {
    const card = ensureCard(item.name);
    paintBadge(card, item.state);
    card.pid.textContent = item.pid != null ? `pid ${item.pid}` : '';
  }
}

// ── Single multiplexed event stream ───────────────────────────────────────────
function connectEvents() {
  const es = new EventSource('/api/events');
  es.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === 'state') {
      applyState(msg);
    } else if (msg.type === 'log') {
      if (msg.name === CONSOLE) appendLog(consolePane, msg);
      else appendLog(ensureCard(msg.name), msg);
    }
  };
}

// ── Config + bulk controls ────────────────────────────────────────────────────
async function loadConfig() {
  const cfg = await api('/api/config');
  if (typeof cfg.tag === 'string') tagInput.value = cfg.tag;
  if (cfg.mode === 'local' || cfg.mode === 'hosted') modeSelect.value = cfg.mode;
}

configForm.addEventListener('submit', (ev) => {
  ev.preventDefault();
  configStatus.textContent = 'applying…';
  void api('/api/config', 'POST', { tag: tagInput.value.trim(), mode: modeSelect.value }).then(
    (r) => {
      configStatus.textContent = r.ok ? `applied (${r.mode})` : `error: ${r.error ?? 'failed'}`;
    },
  );
});

document.querySelectorAll('button[data-all]').forEach((btn) => {
  btn.addEventListener('click', () => {
    btn.disabled = true;
    // Progress (steps + state) streams over /api/events while this resolves.
    void api(`/api/all/${btn.dataset.all}`, 'POST').finally(() => {
      btn.disabled = false;
    });
  });
});

void loadConfig();
connectEvents();
