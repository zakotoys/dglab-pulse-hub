import type { MenuItemConstructorOptions } from 'electron';

export const applicationLocales = ['en-US', 'zh-CN', 'ja-JP'] as const;
export type ApplicationLocale = (typeof applicationLocales)[number];

const productName = 'DGLab Pulse Hub';

const labels = {
  'en-US': {
    file: 'File',
    edit: 'Edit',
    window: 'Window',
    about: `About ${productName}`,
    services: 'Services',
    hide: `Hide ${productName}`,
    hideOthers: 'Hide Others',
    showAll: 'Show All',
    quit: `Quit ${productName}`,
    close: 'Close Window',
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    delete: 'Delete',
    selectAll: 'Select All',
    minimize: 'Minimize',
    zoom: 'Zoom',
    front: 'Bring All to Front'
  },
  'zh-CN': {
    file: '文件',
    edit: '编辑',
    window: '窗口',
    about: `关于 ${productName}`,
    services: '服务',
    hide: `隐藏 ${productName}`,
    hideOthers: '隐藏其他',
    showAll: '全部显示',
    quit: `退出 ${productName}`,
    close: '关闭窗口',
    undo: '撤销',
    redo: '重做',
    cut: '剪切',
    copy: '拷贝',
    paste: '粘贴',
    delete: '删除',
    selectAll: '全选',
    minimize: '最小化',
    zoom: '缩放',
    front: '前置全部窗口'
  },
  'ja-JP': {
    file: 'ファイル',
    edit: '編集',
    window: 'ウインドウ',
    about: `${productName} について`,
    services: 'サービス',
    hide: `${productName} を隠す`,
    hideOthers: 'ほかを隠す',
    showAll: 'すべてを表示',
    quit: `${productName} を終了`,
    close: 'ウインドウを閉じる',
    undo: '取り消す',
    redo: 'やり直す',
    cut: 'カット',
    copy: 'コピー',
    paste: 'ペースト',
    delete: '削除',
    selectAll: 'すべてを選択',
    minimize: 'しまう',
    zoom: '拡大／縮小',
    front: 'すべてを手前に移動'
  }
} as const;

export function resolveApplicationLocale(locale: string): ApplicationLocale {
  const normalized = locale.toLowerCase();
  if (normalized === 'zh' || normalized.startsWith('zh-')) return 'zh-CN';
  if (normalized === 'ja' || normalized.startsWith('ja-')) return 'ja-JP';
  return 'en-US';
}

export function isApplicationLocale(value: unknown): value is ApplicationLocale {
  return applicationLocales.includes(value as ApplicationLocale);
}

export function applicationMenuTemplate(
  platform: NodeJS.Platform,
  locale: ApplicationLocale
): MenuItemConstructorOptions[] | null {
  if (platform !== 'darwin') return null;
  const text = labels[locale];

  return [
    {
      label: productName,
      submenu: [
        { label: text.about, role: 'about' },
        { type: 'separator' },
        { label: text.services, role: 'services' },
        { type: 'separator' },
        { label: text.hide, role: 'hide' },
        { label: text.hideOthers, role: 'hideOthers' },
        { label: text.showAll, role: 'unhide' },
        { type: 'separator' },
        { label: text.quit, role: 'quit' }
      ]
    },
    { label: text.file, submenu: [{ label: text.close, role: 'close' }] },
    {
      label: text.edit,
      submenu: [
        { label: text.undo, role: 'undo' },
        { label: text.redo, role: 'redo' },
        { type: 'separator' },
        { label: text.cut, role: 'cut' },
        { label: text.copy, role: 'copy' },
        { label: text.paste, role: 'paste' },
        { label: text.delete, role: 'delete' },
        { type: 'separator' },
        { label: text.selectAll, role: 'selectAll' }
      ]
    },
    {
      label: text.window,
      submenu: [
        { label: text.minimize, role: 'minimize' },
        { label: text.zoom, role: 'zoom' },
        { type: 'separator' },
        { label: text.front, role: 'front' }
      ]
    }
  ];
}
