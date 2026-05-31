'use client';

import { createContext, useContext, type ReactElement, type ReactNode } from 'react';

/**
 * Callbacks the host app injects so HudCard's buttons can trigger
 * persisted state changes. The HUD package stays UI-only: it doesn't
 * know about server actions, Supabase, or routing.
 *
 * Each handler is optional. If `pin` is undefined the Pin button hides;
 * if `dismiss` is undefined the Dismiss button hides. This lets hud-next
 * (the daemon UI, no roundtrip wired yet) and the portal coexist using
 * the same components.
 *
 * Handlers may be async; the caller awaits to surface errors via toast
 * or a fallback rollback. Errors are NOT swallowed inside HudCard —
 * users would see a silent broken button. The host's handler is
 * responsible for try/catch + UX feedback.
 */
export interface CardActions {
  pin?: (cardId: string) => void | Promise<void>;
  unpin?: (cardId: string) => void | Promise<void>;
  dismiss?: (cardId: string) => void | Promise<void>;
}

const CardActionsContext = createContext<CardActions>({});

export function CardActionsProvider({
  actions,
  children,
}: {
  actions: CardActions;
  children: ReactNode;
}): ReactElement {
  return <CardActionsContext.Provider value={actions}>{children}</CardActionsContext.Provider>;
}

export function useCardActions(): CardActions {
  return useContext(CardActionsContext);
}
