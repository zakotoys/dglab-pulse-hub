const { readFile, rm, writeFile } = require('node:fs/promises');
const path = require('node:path');
const plist = require('plist');

const iconBasePath = path.join(__dirname, 'assets', 'dglab-pulse-hub-icon');
const obsoleteMacMetadataKeys = [
  'NSAppTransportSecurity',
  'NSAudioCaptureUsageDescription',
  'NSBluetoothAlwaysUsageDescription',
  'NSBluetoothPeripheralUsageDescription',
  'NSCameraUsageDescription',
  'NSMicrophoneUsageDescription'
];

function removeUnusedElectronMacMetadata(buildPath, _version, platform, _arch, callback) {
  if (platform !== 'darwin' && platform !== 'mas') {
    callback();
    return;
  }
  const contents = path.join(buildPath, 'Electron.app', 'Contents');
  const infoPlist = path.join(contents, 'Info.plist');
  const cleanup = async () => {
    await rm(path.join(contents, 'Resources', 'electron.icns'), { force: true });
    const info = plist.parse(await readFile(infoPlist, 'utf8'));
    for (const key of obsoleteMacMetadataKeys) delete info[key];
    await writeFile(infoPlist, plist.build(info));
  };
  void cleanup().then(() => callback(), callback);
}

module.exports = {
  packagerConfig: {
    asar: true,
    appBundleId: 'com.zakotoys.dglab-pulse-hub',
    appCategoryType: 'public.app-category.utilities',
    appCopyright: 'Copyright (c) ZakoToys',
    executableName: 'DGLab Pulse Hub',
    icon: iconBasePath,
    afterExtract: [removeUnusedElectronMacMetadata],
    extendInfo: {
      CFBundleIconFile: 'dglab-pulse-hub-icon.icns'
    },
    win32metadata: {
      CompanyName: 'ZakoToys',
      FileDescription: 'DGLab Pulse Hub',
      InternalName: 'DGLab Pulse Hub',
      OriginalFilename: 'DGLab Pulse Hub.exe',
      ProductName: 'DGLab Pulse Hub'
    },
    ignore: [
      /^\/assets(?:\/|$)/,
      /^\/src(?:\/|$)/,
      /^\/test(?:\/|$)/,
      /^\/forge\.config\.cjs$/,
      /^\/vite(?:\.main)?\.config\.ts$/,
      /^\/tsconfig\.json$/,
      /^\/dist\/tsconfig\.tsbuildinfo$/,
      /^\/dist\/preload\.js$/,
      /\.d\.ts$/,
      /\.map$/,
      /\.ts$/
    ]
  },
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'DGLabPulseHub',
        title: 'DGLab Pulse Hub',
        authors: 'ZakoToys',
        description: 'DG-LAB .pulse waveform workbench',
        exe: 'DGLab Pulse Hub.exe',
        setupExe: 'DGLab Pulse Hub Setup.exe',
        setupIcon: `${iconBasePath}.ico`,
        loadingGif: path.join(__dirname, 'assets', 'dglab-pulse-hub-install.gif'),
        noMsi: true
      }
    },
    {
      name: '@electron-forge/maker-dmg',
      config: {
        title: 'DGLab Pulse Hub',
        icon: `${iconBasePath}.icns`
      }
    },
    {
      name: '@electron-forge/maker-zip'
    }
  ]
};
