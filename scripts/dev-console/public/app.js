// Dev-console browser client (plan U5). Dumb renderer: the server ships
// pre-rendered { html, level } log payloads over SSE and JSON state snapshots;
// this file only wires controls and paints. No build step, no dependencies.

const procs = document.getElementById('procs');
const configForm = document.getElementById('config');
const tagInput = document.getElementById('tag');
const modeSelect = document.getElementById('mode');
const configStatus = document.getElementById('config-status');
const activityBar = document.getElementById('activity');
const activityText = document.getElementById('activity-text');

const cards = new Map(); // name -> { root, badge, pid, logs, stream, atBottom }

async function api(path, method = 'GET', body) {
  const opts = { method };
  if (body !== undefined) {
    opts.headers = { 'content-type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  return res.json().catch(() => ({}));
}

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

  card = { root, badge, pid, logs, stream: null, atBottom: true };

  root.querySelectorAll('button[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => {
      void api(`/api/proc/${encodeURIComponent(name)}/${btn.dataset.act}`, 'POST').then(
        refreshState,
      );
    });
  });
  expandBtn.addEventListener('click', () => toggleExpand(card, expandBtn));
  logs.addEventListener('scroll', () => {
    card.atBottom = logs.scrollTop + logs.clientHeight >= logs.scrollHeight - 4;
  });

  procs.appendChild(root);
  cards.set(name, card);
  openStream(name, card);
  return card;
}

function openStream(name, card) {
  const es = new EventSource(`/api/logs/${encodeURIComponent(name)}`);
  es.onmessage = (ev) => {
    let payload;
    try {
      payload = JSON.parse(ev.data);
    } catch {
      return;
    }
    const line = document.createElement('span');
    line.className = `log-line ${payload.level ?? 'info'}`;
    line.innerHTML = `${payload.html ?? ''}\n`;
    card.logs.appendChild(line);
    while (card.logs.childElementCount > 1000) card.logs.removeChild(card.logs.firstChild);
    if (card.atBottom) card.logs.scrollTop = card.logs.scrollHeight;
  };
  card.stream = es;
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
      card.stream?.close();
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

async function refreshState() {
  const state = await api('/api/state');
  paintActivity(state.activity);
  const items = state.items ?? [];
  reconcileCards(items.map((i) => i.name));
  for (const item of items) {
    const card = ensureCard(item.name);
    paintBadge(card, item.state);
    card.pid.textContent = item.pid != null ? `pid ${item.pid}` : '';
  }
}

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
      void refreshState();
    },
  );
});

document.querySelectorAll('button[data-all]').forEach((btn) => {
  btn.addEventListener('click', () => {
    btn.disabled = true;
    // The POST resolves only when the (possibly minutes-long) op finishes, so
    // poll quickly meanwhile to surface the activity banner.
    setTimeout(() => void refreshState(), 200);
    void api(`/api/all/${btn.dataset.all}`, 'POST')
      .then(refreshState)
      .finally(() => {
        btn.disabled = false;
      });
  });
});

void loadConfig();
void refreshState();
setInterval(() => void refreshState(), 2000);
