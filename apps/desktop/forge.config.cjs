module.exports = {
  packagerConfig: {
    asar: true,
    appBundleId: 'com.zakotoys.dglab-pulse-hub',
    executableName: 'DGLab Pulse Hub',
    ignore: [
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
        noMsi: true
      }
    },
    {
      name: '@electron-forge/maker-dmg'
    },
    {
      name: '@electron-forge/maker-zip'
    }
  ]
};
