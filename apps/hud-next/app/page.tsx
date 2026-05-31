import type { ReactElement } from 'react';
import { Bootstrap } from './lib/bootstrap';
import { HudShell } from '@risezome/hud-ui';

export default function Page(): ReactElement {
  return (
    <Bootstrap>
      <HudShell />
    </Bootstrap>
  );
}
