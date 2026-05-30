import type { ReactElement } from 'react';
import { Bootstrap } from './components/bootstrap';
import { HudShell } from './components/hud-shell';

export default function Page(): ReactElement {
  return (
    <Bootstrap>
      <HudShell />
    </Bootstrap>
  );
}
