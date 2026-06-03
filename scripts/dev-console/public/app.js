// Dev-console browser client (plan U5). Dumb renderer: the server ships
// pre-rendered { html, level } log payloads over SSE and JSON state snapshots;
// this file only wires controls and paints. No build step, no dependencies.

const procs = document.getElementById('procs');
const configForm = document.getElementById('config');
const tagInput = document.getElementById('tag');
const modeSelect = document.getElementById('mode');
const configStatus = document.getElementById('config-status');

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
      </span>
    </div>
    <pre class="logs"></pre>`;
  root.querySelector('.proc-name').textContent = name;

  const badge = root.querySelector('.badge');
  const pid = root.querySelector('.proc-pid');
  const logs = root.querySelector('.logs');

  card = { root, badge, pid, logs, stream: null, atBottom: true };

  root.querySelectorAll('button[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => {
      void api(`/api/proc/${encodeURIComponent(name)}/${btn.dataset.act}`, 'POST').then(refreshState);
    });
  });
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

function reconcileCards(names) {
  for (const [name, card] of cards) {
    if (!names.includes(name)) {
      card.stream?.close();
      card.root.remove();
      cards.delete(name);
    }
  }
}

async function refreshState() {
  const state = await api('/api/state');
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
  void api('/api/config', 'POST', { tag: tagInput.value.trim(), mode: modeSelect.value }).then((r) => {
    configStatus.textContent = r.ok ? `applied (${r.mode})` : `error: ${r.error ?? 'failed'}`;
    void refreshState();
  });
});

document.querySelectorAll('button[data-all]').forEach((btn) => {
  btn.addEventListener('click', () => {
    btn.disabled = true;
    void api(`/api/all/${btn.dataset.all}`, 'POST').then(refreshState).finally(() => {
      btn.disabled = false;
    });
  });
});

void loadConfig();
void refreshState();
setInterval(() => void refreshState(), 2000);
