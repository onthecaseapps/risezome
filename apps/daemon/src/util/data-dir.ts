import { homedir, platform } from 'node:os';
import { join } from 'node:path';

export function getDataDir(override?: string): string {
  if (override !== undefined) return override;
  const home = homedir();
  switch (platform()) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'Risezome');
    case 'win32': {
      const localAppData = process.env.LOCALAPPDATA;
      if (typeof localAppData === 'string' && localAppData.length > 0) {
        return join(localAppData, 'Risezome');
      }
      return join(home, 'AppData', 'Local', 'Risezome');
    }
    default: {
      const xdg = process.env.XDG_DATA_HOME;
      if (typeof xdg === 'string' && xdg.length > 0) {
        return join(xdg, 'risezome');
      }
      return join(home, '.local', 'share', 'risezome');
    }
  }
}
