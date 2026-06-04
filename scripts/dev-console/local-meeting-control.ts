/**
 * Local-meeting orchestration for the dev console (security/dogfood tooling).
 *
 * Sequences a real meeting captured from the local mic instead of a Recall bot:
 *   start → ensure the sidecar is built (reuse SidecarControl) → mint the
 *           meeting via the portal dev API → tell the bot-worker to begin
 *           capturing into it. Surfaces the live-page URL.
 *   stop  → tell the bot-worker to stop capture → complete the meeting + fire
 *           the post-meeting jobs (recap + gaps) via the portal dev API.
 *
 * One local meeting at a time (one mic). All I/O is injectable so the
 * orchestration is unit-testable without a real portal/bot-worker/sidecar.
 */

export interface LocalMeetingState {
  active: boolean;
  meetingId?: string;
  orgId?: string;
  liveUrl?: string;
}

export interface LocalMeetingDeps {
  /** Portal origin, e.g. http://localhost:3000. */
  readonly portalUrl: string;
  /** Bot-worker HTTP origin, e.g. http://localhost:8787. */
  readonly botWorkerUrl: string;
  /** Shared secret for the bot-worker control surface (Bearer). */
  readonly botWorkerSecret: string;
  /** Build/verify the sidecar; throws if it can't be made ready (R9). */
  readonly ensureSidecar: () => Promise<void>;
  /** Injectable fetch (defaults to global). */
  readonly fetchImpl?: typeof fetch;
  readonly log: (line: string) => void;
}

export class LocalMeetingControl {
  readonly #deps: LocalMeetingDeps;
  readonly #fetch: typeof fetch;
  #state: LocalMeetingState = { active: false };

  constructor(deps: LocalMeetingDeps) {
    this.#deps = deps;
    this.#fetch = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  state(): LocalMeetingState {
    return this.#state;
  }

  /** Start a local-audio meeting. Rejects if one is already running (R8). */
  async start(): Promise<LocalMeetingState> {
    if (this.#state.active) {
      throw new Error('a local meeting is already running');
    }

    // R9: build/verify the sidecar BEFORE minting anything — a missing sidecar
    // must not leave a dangling meeting.
    this.#deps.log('Ensuring audio sidecar…');
    await this.#deps.ensureSidecar();

    // Mint the meeting in the dev org.
    const minted = await this.#postJson(`${this.#deps.portalUrl}/api/dev/local-meeting`, {
      action: 'start',
    });
    if (!minted.ok) {
      throw new Error(`portal mint failed (${String(minted.status)}): ${minted.text}`);
    }
    const { meetingId, orgId } = minted.body as { meetingId?: string; orgId?: string };
    if (typeof meetingId !== 'string' || typeof orgId !== 'string') {
      throw new Error('portal mint returned no meetingId/orgId');
    }

    // Tell the bot-worker to start capturing into it.
    const started = await this.#postJson(
      `${this.#deps.botWorkerUrl}/local-capture/start`,
      { meetingId, orgId },
      { authorization: `Bearer ${this.#deps.botWorkerSecret}` },
    );
    if (!started.ok) {
      // Don't leave a zombie 'recording' meeting — complete it best-effort.
      this.#deps.log(`Bot-worker start failed (${String(started.status)}); cleaning up the minted meeting.`);
      await this.#postJson(`${this.#deps.portalUrl}/api/dev/local-meeting`, {
        action: 'stop',
        meetingId,
        orgId,
      }).catch(() => undefined);
      throw new Error(`bot-worker capture start failed (${String(started.status)}): ${started.text}`);
    }

    this.#state = {
      active: true,
      meetingId,
      orgId,
      liveUrl: `${this.#deps.portalUrl}/meetings/${meetingId}/live`,
    };
    this.#deps.log(`Local meeting started: ${meetingId}`);
    return this.#state;
  }

  /** Stop the active local meeting. No-op when none is running. */
  async stop(): Promise<LocalMeetingState> {
    const { active, meetingId, orgId } = this.#state;
    if (!active || meetingId === undefined || orgId === undefined) {
      return this.#state;
    }

    // Stop capture first (so no further utterances land), then complete the
    // meeting + fire the post-meeting jobs. Both best-effort so a partial
    // failure still clears local state.
    await this.#postJson(
      `${this.#deps.botWorkerUrl}/local-capture/stop`,
      { meetingId },
      { authorization: `Bearer ${this.#deps.botWorkerSecret}` },
    ).catch((err: unknown) => this.#deps.log(`bot-worker stop error: ${String(err)}`));

    await this.#postJson(`${this.#deps.portalUrl}/api/dev/local-meeting`, {
      action: 'stop',
      meetingId,
      orgId,
    }).catch((err: unknown) => this.#deps.log(`portal stop error: ${String(err)}`));

    this.#deps.log(`Local meeting stopped: ${meetingId}`);
    this.#state = { active: false };
    return this.#state;
  }

  async #postJson(
    url: string,
    body: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ ok: boolean; status: number; body: unknown; text: string }> {
    const res = await this.#fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...extraHeaders },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { ok: res.ok, status: res.status, body: parsed, text };
  }
}
