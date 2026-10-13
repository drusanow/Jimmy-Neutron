// Web MIDI input/output pair connected to the simulated Neutron
// (neutr_cube/build/test/sim_sysex_device: the real usb_midi.c + sysex.c built for the host).
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const SIM_PATH = join(here, '..', '..', 'neutr_cube', 'build', 'test', 'sim_sysex_device');

export function startSimulatedNeutron() {
  const proc = spawn(SIM_PATH, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  const input = new EventTarget();
  input.name = 'Neutron neutr_cube';
  const events = [];
  const rl = createInterface({ input: proc.stdout });
  rl.on('line', (line) => {
    if (line.startsWith('#')) { events.push(line.slice(2)); return; }
    if (!line.trim()) return;
    const data = Uint8Array.from(line.trim().split(' ').map((h) => parseInt(h, 16)));
    input.dispatchEvent(new MessageEvent('midimessage', { data }));
  });
  const output = {
    name: 'Neutron neutr_cube',
    sent: [],
    send(bytes) {
      this.sent.push(Array.from(bytes));
      proc.stdin.write(Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join(' ') + '\n');
    },
  };
  return { input, output, events, stop: () => proc.stdin.end() };
}
