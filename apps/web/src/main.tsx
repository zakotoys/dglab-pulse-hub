import { createRoot } from 'react-dom/client';
import { WorkspaceApp } from '@dglab-pulse-hub/workspace-ui';
import { createWebWorkspaceClient } from './client.js';
import '@dglab-pulse-hub/workspace-ui/styles.css';

const root = document.getElementById('root');
if (root === null) throw new Error('Missing web workspace root.');

createRoot(root).render(<WorkspaceApp client={createWebWorkspaceClient()} />);
