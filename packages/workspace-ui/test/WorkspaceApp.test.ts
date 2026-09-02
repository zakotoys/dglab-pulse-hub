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

  it('places the compare and batch run buttons beside their file pickers', () => {
    const client = { fileMode: 'browser' } as WorkspaceClient;
    const markup = renderToStaticMarkup(createElement(WorkspaceApp, { client }));

    expect(markup.match(/class="file-select-row"/g)).toHaveLength(2);

    const selectSecondIndex = markup.indexOf('Select a second file');
    const runDiffIndex = markup.indexOf('Run diff');
    expect(selectSecondIndex).toBeGreaterThan(-1);
    expect(runDiffIndex).toBeGreaterThan(selectSecondIndex);
    expect(markup.slice(selectSecondIndex, runDiffIndex)).not.toContain('</div>');

    const chooseFilesIndex = markup.indexOf('Choose multiple files');
    const runBatchIndex = markup.indexOf('Run batch');
    expect(chooseFilesIndex).toBeGreaterThan(-1);
    expect(runBatchIndex).toBeGreaterThan(chooseFilesIndex);
    expect(markup.slice(chooseFilesIndex, runBatchIndex)).not.toContain('</div>');
  });

  it('keeps the local file manager out of the browser UI', () => {
    const client = { fileMode: 'browser' } as WorkspaceClient;
    const markup = renderToStaticMarkup(createElement(WorkspaceApp, { client }));

    expect(markup).toContain('data-motion-root="workspace"');
    expect(markup).not.toContain('Open local file');
    expect(markup).not.toContain('file-manager');
  });

  it('routes native comparison and batch selection through the file manager', () => {
    const client = { fileMode: 'native' } as WorkspaceClient;
    const markup = renderToStaticMarkup(createElement(WorkspaceApp, { client }));

    expect(markup).toContain('Select a second file');
    expect(markup).toContain('Choose multiple files');
    expect(markup).not.toContain('Open local file');
  });
});
