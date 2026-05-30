import type { ReactElement } from 'react';

// Empty placeholder. U4 fills this with the HudShell that hosts the live
// HUD. U1's scope is the scaffold + bundle baseline + CSP spike + test
// migration manifest — no application content yet.
export default function Page(): ReactElement {
  return <main id="app" />;
}
