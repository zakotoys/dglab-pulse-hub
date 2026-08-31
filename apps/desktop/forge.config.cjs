module.exports = {
  packagerConfig: {
    asar: true,
    executableName: 'pulse-hub',
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
      name: '@electron-forge/maker-zip'
    }
  ]
};
