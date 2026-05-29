export type SettingsTab = 'credentials' | 'consent' | 'sources' | 'telemetry' | 'diagnostics';

export interface SettingsPanelOptions {
  readonly container: HTMLElement;
  readonly initialTab?: SettingsTab;
}

export class SettingsPanel {
  readonly #container: HTMLElement;
  #currentTab: SettingsTab;

  constructor(options: SettingsPanelOptions) {
    this.#container = options.container;
    this.#currentTab = options.initialTab ?? 'credentials';
    this.#render();
  }

  switchTab(tab: SettingsTab): void {
    this.#currentTab = tab;
    this.#render();
  }

  currentTab(): SettingsTab {
    return this.#currentTab;
  }

  #render(): void {
    const doc = this.#container.ownerDocument;
    this.#container.replaceChildren();
    const tabs: SettingsTab[] = ['credentials', 'consent', 'sources', 'telemetry', 'diagnostics'];
    const tabBar = doc.createElement('nav');
    tabBar.className = 'settings-tabs';
    for (const tab of tabs) {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.dataset.tab = tab;
      btn.textContent = tab.charAt(0).toUpperCase() + tab.slice(1);
      if (tab === this.#currentTab) btn.classList.add('active');
      btn.addEventListener('click', () => this.switchTab(tab));
      tabBar.appendChild(btn);
    }
    const body = doc.createElement('section');
    body.className = 'settings-body';
    body.dataset.tab = this.#currentTab;
    body.textContent = `${this.#currentTab} tab content — populated by U22 (credentials, consent) and U24 (telemetry).`;
    this.#container.append(tabBar, body);
  }
}
