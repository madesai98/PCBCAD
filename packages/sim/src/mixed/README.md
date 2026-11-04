# Mixed-signal simulation: behaviour scripts

`runMixedSignal()` co-simulates MCU firmware (AVR ATmega328P, RP2040, or a script emulator), chip
behaviour scripts and the analog circuit. This document is the reference for writing scripts.

## Where scripts attach

| What | Set on the part (`PartDef.sim`) | Or per instance |
| --- | --- | --- |
| Chip model | `{ kind: 'ic', supplyPins, groundPins, Icc, behaviorId: 'my:sensor' }` | `ComponentInstance.behaviorId` |
| CPU emulator | `{ kind: 'mcu', emulator: 'script:my:cpu', clockHz, supplyPins, groundPins, Icc, pinMap }` | `ComponentInstance.mcu.emulator` |

A script is a `BehaviorScript` (`project.behaviors`, or `opts.behaviors`) with `kind: 'chip'` or
`kind: 'mcu-emulator'`. Its `code` is the **body of a function** that receives the API object and
must **`return` the definition object**:

```js
// code === body of: function (chip) { ... }
const REG = 0x00;            // top-level code runs once per chip instance
return {
  setup(chip) { chip.state.count = 0; },
  i2c: { address: 0x48, write(chip, b) { return true; }, read(chip) { return 0; } },
};
```

## Definition object (chip)

| Member | Called | Notes |
| --- | --- | --- |
| `setup(chip)` | once at t = 0 | initialise `chip.state`, set outputs |
| `step(chip, t, dt)` | every `interval` s | `interval` defaults to the run's `sampleInterval` (1 ms) |
| `interval: number` | – | step period in seconds (≥ 1 µs) |
| `inputs: (pin)[]` | – | pins to watch for logic edges |
| `onInput(chip, pin, level, t)` | on each edge of a watched pin | `pin` is exactly as listed in `inputs`; `level` 0/1 |
| `i2c.address` | each address phase | 7-bit number, or `(chip) => number` (e.g. from a strap pin) |
| `i2c.sda`, `i2c.scl` | – | pins on the bus (default `'SDA'`, `'SCL'`) |
| `i2c.start(chip, read)` | after the address matched | `read` true for a read transfer; return `false` to NACK (busy) |
| `i2c.write(chip, byte)` | master wrote a byte | return `false` to NACK, anything else ACKs |
| `i2c.read(chip, ack)` | master reads a byte | return the byte (0–255); `ack` = master ACKs this byte |
| `i2c.stop(chip)` | STOP condition | |
| `spi.sck/mosi/miso/cs` | – | pins (defaults `SCK`/`MOSI`/`MISO`); without `cs` the chip always listens; `csActiveHigh: true` for active-high CS |
| `spi.select(chip, active)` | CS edge | |
| `spi.transfer(chip, byteIn)` | each byte | return the MISO byte |
| `uart.rx/tx/baud` | – | pins (defaults `RX`/`TX`) |
| `uart.receive(chip, byte)` | byte from an MCU TX wired to `uart.rx` | |

Pins can be a pin number (`3` or `'3'`), a pin name (`'SDA'`), or an array of candidates
(`['SDA', 'SDI', 3]` — the first that exists on the part wins).

## The `chip` API

| Member | Description |
| --- | --- |
| `chip.read(pin)` | logic level 0/1 of the pin's node (thresholds 0.3/0.7 × chip supply). Unconnected pins read 0 |
| `chip.voltage(pin)` | node voltage relative to the chip's ground pin (V) |
| `chip.drive(pin, v)` | `'high'` / `'low'` (push-pull through 25 Ω to the chip supply/ground), `'z'` (high-Z), `'pullup'` / `'pulldown'` (35 kΩ), `true`/`false`, or a number = analog volts (25 Ω source) |
| `chip.uartSend(byteOrString)` | send on the chip's UART TX (delivered to the MCU RX on that net, shown in results) |
| `chip.state` | persistent object for your data; must stay JSON-serialisable (snapshotted into `result.chipStates`) |
| `chip.params` | read-only: instance `fields` + `simOverrides` + environment `temperatureC`, `pressurePa`, `humidityPct` + `value` |
| `chip.time` | simulation time (s) of the current call |
| `chip.supply()` | chip supply voltage (V) |
| `chip.hasPin(pin)` | true if the pin exists on the part |
| `chip.log(...)` / `chip.warn(...)` | append to the run log (`console.log` works too) |
| `chip.ref`, `chip.id`, `chip.pins` | reference designator, component id, `[{number, name}]` |

## Rules

- Everything is **synchronous**: no `async`, promises, timers or I/O. Use `step`/`interval` or
  `chip.time` for timing (e.g. store `busyUntil = chip.time + 0.005`).
- Each hook call must finish quickly: the Node sandbox kills the script after **50 ms** per call.
- No globals besides standard JavaScript built-ins (`Math`, `JSON`, `BigInt`, typed arrays, …).
  `Math.random` is seeded (reproducible). `require`, `process`, `fetch`, `eval`/`Function` are
  unavailable. Keep all state in closures or `chip.state`.
- Buses are transaction-level: you see START / address / bytes / STOP, not individual edges. The
  engine only routes I2C to chips whose SDA/SCL share the MCU's bus nets (through ≤ 10 Ω parts and
  interconnect conductors too), and refuses transfers when the bus has no pull-ups.
- Throwing an error logs it and continues; 25 errors (or one timeout) disable the chip.

## Example 1 — I2C temperature sensor (TMP102-style)

```js
// 12-bit temperature in register 0 (0.0625 °C/LSB), config in register 1. Address 0x48–0x4B
// selected by the ADD0 pin. chip.params.temperatureC comes from the run environment.
return {
  name: 'TMP102',
  setup(chip) {
    chip.state.ptr = 0;
    chip.state.config = 0x60a0;
    chip.state.expectPtr = true;
  },
  i2c: {
    sda: ['SDA', 1], scl: ['SCL', 6],
    address(chip) { return chip.hasPin('ADD0') && chip.read('ADD0') ? 0x49 : 0x48; },
    start(chip, read) { chip.state.expectPtr = !read; chip.state.byteIdx = 0; },
    write(chip, b) {
      const s = chip.state;
      if (s.expectPtr) { s.ptr = b & 3; s.expectPtr = false; s.byteIdx = 0; return true; }
      if (s.ptr === 1) {                       // config register, MSB first
        s.config = s.byteIdx === 0 ? (b << 8) | (s.config & 0xff) : (s.config & 0xff00) | b;
        s.byteIdx++;
      }
      return true;
    },
    read(chip) {
      const s = chip.state;
      let word = s.config;
      if (s.ptr === 0) {
        const raw = Math.round(chip.params.temperatureC / 0.0625) & 0xfff;
        word = raw << 4;
      }
      const out = s.byteIdx === 0 ? word >> 8 : word & 0xff;
      s.byteIdx = (s.byteIdx + 1) & 1;
      return out;
    },
  },
};
```

## MCU emulator scripts (`emulator: 'script:<behaviorId>'`)

The definition object provides `load(mcu, bytes, format)` and `run(mcu, cycles)`; optional
`reset(mcu)`, `onInput(mcu, port, level, t)` and `uart: { receive(mcu, byte) }`. `mcu` has the same
API as `chip` plus `mcu.clockHz`; pins are named by the part's `pinMap` port (`'GPIO3'`), pin number
or name. `run()` is called with slices of at most 100 µs worth of cycles and should return the
number of cycles it executed; pin changes made during `run()` are time-stamped at the start of the
slice. `mcu.uartSend()` writes to the MCU's UART output (`result.uart`, port `UART0`). Hardware
I2C/SPI peripherals are not available to script emulators — bit-bang through pins (chips can watch
edges with `inputs`/`onInput`).

## Example 2 — a tiny bytecode CPU

```js
// Firmware: 2-byte instructions [op, arg]
//   0x01 n: pin n high   0x02 n: pin n low   0x03 n: wait n ms
//   0x04 n: jump to instruction n           0x05 c: print character c
// Pins are the pinMap ports P0, P1, ... (pinMap: { P0: '3', P1: '4' }).
let code = new Uint8Array(0);
let pc = 0, wait = 0;
return {
  load(mcu, bytes, format) {
    if (format !== 'bin') throw new Error('expects a .bin image');
    code = bytes;
    pc = 0;
  },
  run(mcu, cycles) {
    let left = cycles;
    while (left > 0) {
      if (wait > 0) { const w = Math.min(wait, left); wait -= w; left -= w; continue; }
      if (pc + 1 >= code.length) return cycles;          // halted: idle
      const op = code[pc], arg = code[pc + 1];
      pc += 2;
      left -= 1;                                          // 1 cycle per instruction
      if (op === 1) mcu.drive('P' + arg, 'high');
      else if (op === 2) mcu.drive('P' + arg, 'low');
      else if (op === 3) wait = Math.round(arg * 1e-3 * mcu.clockHz);
      else if (op === 4) pc = arg * 2;
      else if (op === 5) mcu.uartSend(arg);
    }
    return cycles;
  },
};
```

## Built-in chips (`BUILTIN_BEHAVIORS`)

| id | Model |
| --- | --- |
| `builtin:bme280` | BME280 T/P/H sensor, I2C 0x76/0x77 (SDO) and SPI (CSB). Raw ADC values are derived by inverting the Bosch integer compensation, so datasheet-formula firmware reads `params.temperatureC/pressurePa/humidityPct` back exactly. Forced/normal modes with datasheet timing |
| `builtin:74hc595` | shift register + latch, bit-banged or hardware SPI, ~OE / ~SRCLR |
| `builtin:24c02` | 256-byte EEPROM at 0x50 + A2..A0, 8-byte pages, 5 ms write cycle (ACK polling), `params.contents` hex preload |
| `builtin:ssd1306` | 128×64 OLED at 0x3C/0x3D: commands, addressing modes, `state.fb` (1024 bytes), ASCII render in `state.ascii` and the log |

## Sandboxes and running

```ts
import { runMixedSignal, validateBehaviorScript } from '@pcbcad/sim';
import { createNodeSandbox } from '@pcbcad/sim/mixed/sandbox-node'; // Node only

const sandbox = createNodeSandbox();            // worker thread + node:vm, 50 ms per call
const check = validateBehaviorScript(code, 'chip', sandbox);   // { ok, errors, warnings, shape }
const result = await runMixedSignal(project, { boardId }, {
  duration: 1.0,
  firmware: { [mcuComponentId]: { bytes, format: 'hex', name: 'main.hex' } },
  behaviors: [myScript],
  sandbox,
  environment: { temperatureC: 23.4, pressurePa: 101325, humidityPct: 45 },
});
sandbox.dispose?.();
```

- Built-in scripts run without a sandbox (in-process). Any other script needs `opts.sandbox`:
  `createNodeSandbox()` on the server, or `createFunctionSandbox()` to run **trusted** code in the
  current realm (no isolation, no timeouts — browser fallback).
- Results: `uart` (text per port), `digital` (pin transitions), `analog` (power/LED nets),
  `indicators` (LED on-fraction and mean current), `avgPower`, `log`, `mcus`, `warnings`, plus
  `chipStates` (final `chip.state` per script) and `stats`.

## RP2040 bootrom

pico-sdk and MicroPython images need the RP2040 mask ROM, which is not bundled (part of it is
licensed for use on RP2040 silicon only). Provide the 16 KB B1 ROM yourself — e.g. `bootromB1`
from `demo/bootrom.ts` in the rp2040js GitHub repository — with `setRp2040Bootrom(words)` or
`emulatorOptions: { [componentId]: { bootrom } }`. MicroPython's REPL is on USB-CDC: its output is
`result.uart` port `'USB'` and input goes to `uartInput: { 'componentId:USB': 'print(1)\r\n' }`.
