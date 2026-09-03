import { describe, expect, it } from 'vitest';
import { applicationMenuTemplate } from '../src/application-menu.js';

describe('desktop application menu', () => {
  it.each(['win32', 'linux'] as const)('removes the in-window menu on %s', (platform) => {
    expect(applicationMenuTemplate(platform, 'zh-CN')).toBeNull();
  });

  it('localizes the native macOS menu in Simplified Chinese', () => {
    const template = applicationMenuTemplate('darwin', 'zh-CN');

    expect(template?.map((item) => item.label)).toEqual([
      'DGLab Pulse Hub',
      '文件',
      '编辑',
      '窗口'
    ]);
    expect(template?.[0]?.submenu).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: '关于 DGLab Pulse Hub', role: 'about' }),
        expect.objectContaining({ label: '退出 DGLab Pulse Hub', role: 'quit' })
      ])
    );
  });

  it('localizes the native macOS menu in Japanese', () => {
    const template = applicationMenuTemplate('darwin', 'ja-JP');

    expect(template?.map((item) => item.label)).toEqual([
      'DGLab Pulse Hub',
      'ファイル',
      '編集',
      'ウインドウ'
    ]);
    expect(template?.[0]?.submenu).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'DGLab Pulse Hub について', role: 'about' }),
        expect.objectContaining({ label: 'DGLab Pulse Hub を終了', role: 'quit' })
      ])
    );
  });
});
