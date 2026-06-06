import type { ReactElement, ReactNode } from 'react';
import { SettingsNav } from './_nav';

/**
 * Settings shell (mockup #24): a left category nav down the side, the selected
 * page's content on the right. Each page keeps its own header + body; this
 * layout only supplies the category column.
 */
export default function SettingsLayout({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="flex min-h-full">
      <SettingsNav />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
