'use strict';
// Bundles the React interface. A script instead of command-line flags so it
// behaves the same in macOS Terminal and Windows PowerShell or cmd.
const esbuild = require('esbuild');
const path = require('node:path');

esbuild.buildSync({
  entryPoints: [path.join(__dirname, '..', 'src', 'renderer', 'app.jsx')],
  outfile: path.join(__dirname, '..', 'dist', 'renderer.js'),
  bundle: true,
  minify: true,
  jsx: 'automatic',
  loader: { '.jsx': 'jsx' },
  define: { 'process.env.NODE_ENV': '"production"' },
});
console.log('Built dist/renderer.js');
