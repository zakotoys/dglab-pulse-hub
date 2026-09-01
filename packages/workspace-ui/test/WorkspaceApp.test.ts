import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WorkspaceApp } from '../src/WorkspaceApp.js';
import type { WorkspaceClient } from '../src/client.js';

describe('WorkspaceApp QR image controls', () => {
  it('places QR preview directly above QR export', () => {
    const client = { fileMode: 'browser' } as WorkspaceClient;
    const markup = renderToStaticMarkup(createElement(WorkspaceApp, { client }));
    const previewIndex = markup.indexOf('Preview QR image');
    const exportIndex = markup.indexOf('Export QR image');

    expect(previewIndex).toBeGreaterThan(-1);
    expect(exportIndex).toBeGreaterThan(previewIndex);
  });

  it('renders the requested locale and preference controls', () => {
    const client = { fileMode: 'browser' } as WorkspaceClient;
    const markup = renderToStaticMarkup(
      createElement(WorkspaceApp, { client, initialLocale: 'ja-JP', initialTheme: 'dark' })
    );

    expect(markup).toContain('パルスドキュメントを開く');
    expect(markup).toContain('aria-label="言語"');
    expect(markup).toContain('data-theme="dark"');
  });

  it('uses a home control instead of exposing the rules version in navigation', () => {
    const client = { fileMode: 'browser' } as WorkspaceClient;
    const markup = renderToStaticMarkup(createElement(WorkspaceApp, { client }));

    expect(markup).toContain('aria-label="Home"');
    expect(markup).toContain('title="Refresh workspace"');
    expect(markup).not.toContain('rules pulse-rules-v1');
  });
});
