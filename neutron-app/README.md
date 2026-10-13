# Neutron Editor

Settings editor, oscillator tuner and firmware updater for the Behringer Neutron running the
**neutr_cube** firmware (this repository). Runs in Chrome, Edge or Opera on a computer, can be
installed as an app on macOS, and is also available as a standalone Mac app.

**Not yet tested with real hardware.** The protocol, the flasher and the UI are tested against
simulations (see *Tests*), but nobody has run this with a Neutron yet.

## What it does

| | |
|---|---|
| **Settings** | Everything the firmware can store: oscillator range, tune knob range, pitch bend range (0–24), portamento per oscillator, mod inputs on/off, voice mode (mono / paraphonic / pad), osc sync, envelope retrigger, filter mode and key tracking, LFO mode, key sync, MIDI clock sync, sync input edge, retrigger phase, LFO oscillator source and semitone snap, shape drift, assign output source. Changes are heard immediately, **Save to Neutron** keeps them. |
| **Tuning** | Automatic tuning of OSC 1, OSC 2 or both. Manual calibration of note scale, octave scale and pitch offset for each oscillator, filter key tracking and assign output, with test notes and a microphone tuner (accurate to about 1 cent). |
| **Firmware** | Installs neutr_cube (included) or any `.dfu` / `.bin` / `.hex` file, including Behringer's original firmware or a backup. Can back up the complete flash first. Verifies everything it writes. Installing neutr_cube keeps your saved settings and calibration. |

Compared to Behringer's Neutron app, the firmware does not have keyboard split, auto glide, LFO one
shot or poly chain, so those settings are not here. Settings can only be edited with neutr_cube
installed: Behringer's SysEx protocol is not public. Firmware installation works whatever is on the Neutron.

## Running it

**Web:** open the published page (see below) in Chrome, Edge or Opera, connect the Neutron with USB
and press **Connect**. Allow MIDI access with system exclusive messages when asked. Safari and
Firefox do not support WebUSB, and Safari has no Web MIDI.

**Install as a Mac app from Chrome:** on the page, open Chrome's menu → *Cast, save and share* →
*Install page as app* (or the install icon in the address bar). It then lives in Applications,
opens in its own window and works offline.

**Standalone Mac app (Electron):** GitHub builds it on every change to `neutron-app/`
(workflow *Neutron Editor Mac app*): open the latest run under the repository's **Actions** tab and
download **NeutronEditor-mac** from *Artifacts*. It runs on Apple Silicon and Intel Macs. Unzip it
and move *Neutron Editor* to Applications. The app is
not notarised by Apple, so the first time macOS refuses to open it: open *System Settings →
Privacy & Security* and click **Open Anyway** (or run `xattr -dr com.apple.quarantine "/Applications/Neutron Editor.app"`).
To build it yourself: `cd electron && npm install && npm run mac` (on a Mac).

**Locally:** `node tools/serve.mjs` and open http://localhost:8080 (Web MIDI and WebUSB need https or localhost).

### Firmware updates

1. Choose the firmware. The bundled neutr_cube is selected by default.
2. Start the bootloader: with neutr_cube connected press **Restart into bootloader**, otherwise hold
   **OSC SYNC + FILTER MODE** (neutr_cube) or the **BOOT** button on the back (any firmware) while
   switching the Neutron on.
3. **Connect to bootloader**, choose "STM32 BOOTLOADER", optionally **Back up current firmware**,
   then **Install firmware**. The Neutron restarts with the new firmware.

The bootloader lives in the chip's ROM and can not be damaged, so a failed update can always be
repeated. Installing a full 128 kB image (such as Behringer's) replaces the saved settings:
run automatic tuning afterwards (and recalibrate the pots on Behringer firmware, see
`neutr_cube/neutr_src/manual.txt`).

On **Windows** the browser can only use the bootloader with the WinUSB driver. Behringer's own
updater installs it; otherwise use [Zadig](https://zadig.akeo.ie) to install WinUSB for
"STM32 BOOTLOADER". macOS needs no driver.

## Publishing the web version

`.github/workflows/neutron-app-pages.yml` publishes this folder to GitHub Pages on every push to
`main` that changes it. Enable it once in the repository: *Settings → Pages → Source: GitHub Actions*.

To update the bundled firmware: `cd neutr_cube && make app-firmware`, then commit `neutron-app/firmware/`.

## Files

| | |
|---|---|
| `js/protocol.js` | Editor protocol: parameter list, SysEx encoding, `NeutronLink` over Web MIDI |
| `js/dfu.js` | `.dfu` / `.bin` / `.hex` parsing, STM32 DfuSe flasher over WebUSB |
| `js/tuner.js` | Microphone pitch detection (YIN) |
| `js/app.js` | User interface |
| `electron/` | Standalone desktop wrapper |
| `tests/` | Tests, see below |

The protocol is implemented in the firmware in `neutr_cube/neutr_src/sysex.c`:
`F0 7D 4E 43 <cmd> <data> F7`, replies with `cmd | 0x40`. Commands: 01 info, 02 read all,
03 set, 04 save, 05 autotune, 06 defaults, 07 bootloader.

## Tests

```
cd ../neutr_cube && make && make test   # builds the firmware and the simulated Neutron
cd ../neutron-app && npm test
```

- `protocol.test.mjs` talks to a simulated Neutron: the firmware's own `usb_midi.c` and `sysex.c`
  compiled for the computer. Every parameter, limits, autotune, save, defaults, bootloader.
- `dfu.test.mjs` flashes real images onto a simulated STM32 ROM bootloader with realistic flash
  (erase before write, busy states): installing over Behringer's firmware keeps the settings page,
  restoring the full original dump, backups, recovery after a failed write.
- `ui.test.mjs` runs the interface in Chromium (Playwright) wired to both simulations: connect,
  edit, save, autotune, calibration, test notes, installing firmware. Set `SCREENSHOTS=dir` to keep screenshots.
- `tuner.test.mjs` checks pitch detection on sine, saw and square waves.
