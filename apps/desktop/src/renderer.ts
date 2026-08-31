import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkspaceApp } from '@dglab-pulse-hub/workspace-ui';
import { createElectronWorkspaceClient } from './client.js';
import '@dglab-pulse-hub/workspace-ui/styles.css';

const root = document.getElementById('root');
if (root === null) throw new Error('Missing desktop workspace root.');

createRoot(root).render(createElement(WorkspaceApp, { client: createElectronWorkspaceClient() }));
