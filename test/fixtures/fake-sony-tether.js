// Stands in for native/sony/bin/sony-tether in tests.
const readline = require('node:readline');
const dir = process.argv[process.argv.indexOf('--save-dir') + 1];
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
out({ event: 'ready' });
out({ event: 'searching' });
out({ event: 'connecting', model: 'ILCE-7M4', id: 'D123' });
out({ event: 'connected', model: 'ILCE-7M4', id: 'D123' });
let n = 0;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (line === 'shoot') out({ event: 'file', path: `${dir}/DSC0000${++n}.ARW` });
  if (line === 'unplug') out({ event: 'disconnected', model: 'ILCE-7M4' });
  if (line === 'quit') process.exit(0);
});
