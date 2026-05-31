'use client';

import { createContext, useContext, type ReactElement, type ReactNode } from 'react';

/**
 * Callbacks the host app injects so SynthesisCard's pin button can
 * trigger persisted state changes (plan U5). Mirror of CardActions —
 * the HUD package stays UI-only, the host wires server actions +
 * optimistic dispatch.
 *
 * Both handlers are optional. When `pin` is undefined the pin button
 * hides; same for `unpin`. Errors are NOT swallowed by the SynthesisCard
 * — the host's handler is responsible for try/catch + UX feedback (the
 * portal does optimistic dispatch + rollback on failure, mirroring the
 * cardActions pattern).
 */
export interface SynthesisActions {
  pin?: (synthesisId: string) => void | Promise<void>;
  unpin?: (synthesisId: string) => void | Promise<void>;
}

const SynthesisActionsContext = createContext<SynthesisActions>({});

export function SynthesisActionsProvider({
  actions,
  children,
}: {
  actions: SynthesisActions;
  children: ReactNode;
}): ReactElement {
  return (
    <SynthesisActionsContext.Provider value={actions}>{children}</SynthesisActionsContext.Provider>
  );
}

export function useSynthesisActions(): SynthesisActions {
  return useContext(SynthesisActionsContext);
}
