/**
 * electron-builder afterPack hook.
 * Copies the prebuilt better_sqlite3.node Windows binary into the packed app.
 * Only runs when target platform is win32.
 */
const path = require('path');
const fs = require('fs');

exports.default = async function(context) {
  if (context.electronPlatformName !== 'win32') return;

  const prebuiltSrc = path.join(__dirname, '..', 'prebuilt-win32-x64', 'better_sqlite3.node');
  if (!fs.existsSync(prebuiltSrc)) {
    throw new Error('Prebuilt better_sqlite3.node not found at: ' + prebuiltSrc);
  }

  const unpackedDir = path.join(
    context.appOutDir,
    'resources',
    'app.asar.unpacked',
    'node_modules',
    'better-sqlite3',
    'build',
    'Release'
  );

  if (fs.existsSync(unpackedDir)) {
    const dest = path.join(unpackedDir, 'better_sqlite3.node');
    fs.copyFileSync(prebuiltSrc, dest);
    console.log('  Injected prebuilt Win32 better_sqlite3.node into app');
  } else {
    console.warn('  Unpacked dir not found:', unpackedDir);
  }
};
