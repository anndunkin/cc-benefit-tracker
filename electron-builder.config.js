module.exports = {
  appId: "com.dunkinglobal.ccbenefittracker",
  productName: "Credit Card Benefit Tracker",
  directories: { output: "dist-installer" },
  files: [
    "dist/**/*",
    "electron/dist/**/*",
    "node_modules/**/*",
    "!node_modules/*/{CHANGELOG.md,README.md,readme.md}",
    "!node_modules/*/{test,__tests__,tests,example,examples}",
    "!node_modules/.bin",
    "prebuilt-win32-x64/**/*"
  ],
  asar: true,
  asarUnpack: [
    "node_modules/better-sqlite3/build/Release/*.node",
    "electron/dist/preload.js"
  ],
  extraResources: [
    { from: "assets", to: "assets" }
  ],
  npmRebuild: false,
  afterPack: "./scripts/afterPack.js",
  win: {
    target: [
      { target: "zip", arch: ["x64"] },
      { target: "nsis", arch: ["x64"] }
    ],
    icon: "assets/icon.ico",
    requestedExecutionLevel: "asInvoker",
    forceCodeSigning: false,
    // signAndEditExecutable must be true so electron-builder rewrites the
    // Credit Card Benefit Tracker.exe icon resource with assets/icon.ico.
    // We still handle Authenticode signing ourselves via osslsigncode after
    // the build, so we disable only the code-signing part via signExecutable.
    signAndEditExecutable: true,
    signExecutable: false
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    perMachine: false,
    allowElevation: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: "Credit Card Benefit Tracker",
    deleteAppDataOnUninstall: false,
    include: "scripts/installer.nsh"
  },
  mac: {
    target: "dmg",
    icon: "assets/icon.png"
  },
  linux: {
    target: "AppImage",
    icon: "assets/icon.png"
  }
}
