// Stands in for native/sony/bin/sony-tether in tests.
const readline = require('node:readline');
const dir = process.argv[process.argv.indexOf('--save-dir') + 1];
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const props = {
  256: { code: 256, type: 2, value: 560, writable: true, values: [400, 560, 800] }, // aperture
  259: { code: 259, type: 3, value: 0x1007d, writable: true, values: [0x1007d, 0x100fa] }, // 1/125, 1/250
  270: { code: 270, type: 3, value: 1, writable: true, values: [1, 0x40301] }, // single, bracket
  261: { code: 261, type: 3, value: 1, writable: false, values: [] }, // M
};
out({ event: 'ready' });
out({ event: 'searching' });
out({ event: 'connecting', model: 'ILCE-7M4', id: 'D123' });
out({ event: 'connected', model: 'ILCE-7M4', id: 'D123' });
out({ event: 'props', props: Object.values(props) });
let n = 0;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const [cmd, ...args] = line.split(' ');
  if (cmd === 'shoot') {
    out({ event: 'file', path: `${dir}/DSC0000${++n}.ARW` });
    out({ event: 'warning', message: `pressed ${args.join(' ')}` });
  }
  if (cmd === 'set' && props[args[0]]) {
    props[args[0]].value = Number(args[1]);
    out({ event: 'props', props: [props[args[0]]] });
  }
  if (cmd === 'unplug') out({ event: 'disconnected', model: 'ILCE-7M4' });
  if (cmd === 'quit') process.exit(0);
});
