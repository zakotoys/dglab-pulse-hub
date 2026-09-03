import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkspaceApp, type Locale } from '@dglab-pulse-hub/workspace-ui';
import { createElectronWorkspaceClient } from './client.js';
import '@dglab-pulse-hub/workspace-ui/styles.css';

const root = document.getElementById('root');
if (root === null) throw new Error('Missing desktop workspace root.');

function updateApplicationMenu(locale: Locale): void {
  void window.pulseDesktop?.setLocale(locale).catch(() => undefined);
}

createRoot(root).render(
  createElement(WorkspaceApp, {
    client: createElectronWorkspaceClient(),
    onLocaleChange: updateApplicationMenu
  })
);
