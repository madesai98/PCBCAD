/**
 * Built-in chip behaviour scripts: 74HC595 shift register, 24C02 EEPROM, SSD1306 OLED controller.
 */

/**
 * builtin:74hc595 — 8-bit serial-in / parallel-out shift register with output latch.
 * Standard 16-pin pinout (DIP/SOIC/TSSOP): QB..QH = 1..7, GND 8, QH' 9, ~SRCLR 10, SRCLK 11,
 * RCLK 12, ~OE 13, SER 14, QA 15, VCC 16. Works bit-banged (SRCLK/RCLK edges via `inputs`) and
 * with a hardware SPI master (SCK→SRCLK, MOSI→SER, MISO←QH'); RCLK latches on its rising edge.
 */
export const HC595_CODE = String.raw`
const Q = [15, 1, 2, 3, 4, 5, 6, 7]; // QA..QH
const SER = 14, SRCLK = 11, RCLK = 12, SRCLR = 10, OE = 13, QH2 = 9;
function outputs(chip) {
  const s = chip.state;
  const oe = chip.read(OE); // active low
  for (let i = 0; i < 8; i++) chip.drive(Q[i], oe ? 'z' : ((s.latch >> i) & 1 ? 'high' : 'low'));
  chip.drive(QH2, (s.sr >> 7) & 1 ? 'high' : 'low');
}
return {
  name: '74HC595',
  inputs: [SRCLK, RCLK, SRCLR, OE],
  setup(chip) {
    chip.state.sr = 0;
    chip.state.latch = 0;
    if (!chip.read(SRCLR)) chip.warn('~SRCLR (pin 10) is low/unconnected: the shift register is held cleared');
    outputs(chip);
  },
  onInput(chip, pin, level) {
    const s = chip.state;
    if (pin === SRCLK && level) {
      if (chip.read(SRCLR)) s.sr = ((s.sr << 1) | chip.read(SER)) & 0xff;
      chip.drive(QH2, (s.sr >> 7) & 1 ? 'high' : 'low');
    } else if (pin === RCLK && level) {
      s.latch = s.sr;
      outputs(chip);
    } else if (pin === SRCLR && !level) {
      s.sr = 0;
      chip.drive(QH2, 'low');
    } else if (pin === OE) {
      outputs(chip);
    }
  },
  spi: {
    sck: SRCLK, mosi: SER, miso: QH2,
    transfer(chip, b) {
      const s = chip.state;
      const out = s.sr;
      if (chip.read(SRCLR)) s.sr = b & 0xff;
      chip.drive(QH2, (s.sr >> 7) & 1 ? 'high' : 'low');
      return out;
    },
  },
};
`;

/**
 * builtin:24c02 — 2 Kbit (256 × 8) I2C EEPROM. Address 0x50 | A2A1A0 (pins 3,2,1).
 * Byte/page write (8-byte pages, address wraps within the page), 5 ms write cycle during which the
 * device NACKs its address (acknowledge polling), current-address / random / sequential reads.
 * Initial contents 0xFF, or chip.params.contents as a hex string ('DEADBEEF…').
 */
export const EEPROM24C02_CODE = String.raw`
const SIZE = 256, PAGE = 8;
const bit = (chip, n) => (chip.hasPin(n) && chip.read(n) ? 1 : 0);
return {
  name: '24C02',
  setup(chip) {
    const s = chip.state;
    s.mem = new Array(SIZE).fill(0xff);
    const hex = typeof chip.params.contents === 'string' ? chip.params.contents.replace(/[^0-9a-fA-F]/g, '') : '';
    for (let i = 0; i + 1 < hex.length && i / 2 < SIZE; i += 2) s.mem[i / 2] = parseInt(hex.substr(i, 2), 16);
    s.ptr = 0; s.busyUntil = -1; s.pending = [];
  },
  i2c: {
    sda: ['SDA', 5], scl: ['SCL', 6],
    address(chip) { return 0x50 | (bit(chip, 3) << 2) | (bit(chip, 2) << 1) | bit(chip, 1); },
    start(chip, read) {
      const s = chip.state;
      if (chip.time < s.busyUntil) return false; // internal write cycle: NACK
      s.phase = read ? 'read' : 'word';
      s.pending = [];
      return true;
    },
    write(chip, b) {
      const s = chip.state;
      if (s.phase === 'word') { s.ptr = b & 0xff; s.phase = 'data'; return true; }
      if (s.phase !== 'data') return false;
      s.pending.push([s.ptr, b & 0xff]);
      s.ptr = (s.ptr & ~(PAGE - 1)) | ((s.ptr + 1) & (PAGE - 1));
      return true;
    },
    read(chip) {
      const s = chip.state;
      const v = s.mem[s.ptr];
      s.ptr = (s.ptr + 1) & (SIZE - 1);
      return v;
    },
    stop(chip) {
      const s = chip.state;
      if (s.pending && s.pending.length) {
        for (const [a, v] of s.pending) s.mem[a] = v;
        s.pending = [];
        s.busyUntil = chip.time + 0.005;
        s.writes = (s.writes || 0) + 1;
      }
      s.phase = 'idle';
    },
  },
};
`;

/**
 * builtin:ssd1306 — 128×64 monochrome OLED controller on I2C (0x3C, or 0x3D when SA0/D/C is
 * high). Parses the command set (addressing modes, column/page windows, page-mode pointers,
 * contrast, display on/off, invert, remap, COM scan direction, start line, charge pump, scroll
 * commands with their argument counts) and the control-byte protocol (Co / D/C#). The 1024-byte
 * GDDRAM is kept in chip.state.fb (fb[page*128 + col], bit n = row page*8+n). After a
 * transaction that changed the display, an ASCII rendering (64×16 characters, 2×4 pixels each) is
 * stored in chip.state.ascii and logged (at most every 100 ms of simulated time).
 */
export const SSD1306_CODE = String.raw`
const ARGS = { 0x20: 1, 0x21: 2, 0x22: 2, 0x26: 6, 0x27: 6, 0x29: 5, 0x2a: 5, 0x81: 1, 0x8d: 1, 0xa3: 2,
  0xa8: 1, 0xd3: 1, 0xd5: 1, 0xd9: 1, 0xda: 1, 0xdb: 1 };
function render(s) {
  const W = 128, H = 64;
  const px = (x, y) => {
    let col = s.remap ? W - 1 - x : x;
    let row = (y + s.startLine) % 64;
    if (s.comDec) row = 63 - row;
    let on = (s.fb[(row >> 3) * 128 + col] >> (row & 7)) & 1;
    if (s.entireOn) on = 1;
    return s.invert ? 1 - on : on;
  };
  const lines = [];
  for (let cy = 0; cy < H; cy += 4) {
    let line = '';
    for (let cx = 0; cx < W; cx += 2) {
      let n = 0;
      for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 2; dx++) n += px(cx + dx, cy + dy);
      line += n === 0 ? ' ' : n <= 2 ? '.' : n <= 5 ? ':' : '#';
    }
    lines.push(line.replace(/\s+$/, ''));
  }
  return s.on ? lines.join('\n') : '(display off)';
}
function command(s, c, args) {
  if (c >= 0xb0 && c <= 0xb7) { s.page = c & 7; return; }
  if (c <= 0x0f) { s.col = (s.col & 0xf0) | c; s.pmColStart = s.col; return; }
  if (c >= 0x10 && c <= 0x1f) { s.col = ((c & 0x0f) << 4) | (s.col & 0x0f); s.pmColStart = s.col; return; }
  if (c >= 0x40 && c <= 0x7f) { s.startLine = c & 0x3f; s.dirty = true; return; }
  switch (c) {
    case 0x20: s.mode = args[0] & 3; break;
    case 0x21: s.colStart = args[0] & 0x7f; s.colEnd = args[1] & 0x7f; s.col = s.colStart; break;
    case 0x22: s.pageStart = args[0] & 7; s.pageEnd = args[1] & 7; s.page = s.pageStart; break;
    case 0x81: s.contrast = args[0]; break;
    case 0x8d: s.chargePump = (args[0] & 0x04) !== 0; break;
    case 0xa0: case 0xa1: s.remap = c === 0xa1; s.dirty = true; break;
    case 0xa4: case 0xa5: s.entireOn = c === 0xa5; s.dirty = true; break;
    case 0xa6: case 0xa7: s.invert = c === 0xa7; s.dirty = true; break;
    case 0xae: case 0xaf: s.on = c === 0xaf; s.dirty = true; break;
    case 0xc0: case 0xc8: s.comDec = c === 0xc8; s.dirty = true; break;
    case 0x2e: s.scrolling = false; break;
    case 0x2f: s.scrolling = true; break;
    default: break;
  }
}
function data(s, b) {
  s.fb[s.page * 128 + s.col] = b;
  s.dirty = true;
  if (s.mode === 0) {
    if (++s.col > s.colEnd) { s.col = s.colStart; if (++s.page > s.pageEnd) s.page = s.pageStart; }
  } else if (s.mode === 1) {
    if (++s.page > s.pageEnd) { s.page = s.pageStart; if (++s.col > s.colEnd) s.col = s.colStart; }
  } else {
    if (++s.col > 127) s.col = s.pmColStart || 0;
  }
}
return {
  name: 'SSD1306',
  setup(chip) {
    Object.assign(chip.state, {
      fb: new Array(1024).fill(0), on: false, mode: 2, col: 0, page: 0, colStart: 0, colEnd: 127,
      pageStart: 0, pageEnd: 7, pmColStart: 0, startLine: 0, remap: false, comDec: false, invert: false,
      entireOn: false, contrast: 0x7f, chargePump: false, scrolling: false, dirty: false, updates: 0,
      lastLog: -1, ascii: '',
    });
  },
  i2c: {
    sda: ['SDA', 'D1', 'SDIN'], scl: ['SCL', 'D0', 'SCLK'],
    address(chip) {
      const sa0 = ['SA0', 'D/C', 'DC'].find((n) => chip.hasPin(n));
      return sa0 && chip.read(sa0) ? 0x3d : 0x3c;
    },
    start(chip) {
      const s = chip.state;
      s.expectControl = true; s.stream = false; s.dc = 0; s.cmd = -1; s.args = [];
    },
    write(chip, b) {
      const s = chip.state;
      if (s.expectControl) {
        s.stream = (b & 0x80) === 0;
        s.dc = (b & 0x40) ? 1 : 0;
        s.expectControl = false;
        return true;
      }
      if (s.dc) data(s, b);
      else if (s.cmd >= 0) {
        s.args.push(b);
        if (s.args.length >= ARGS[s.cmd]) { command(s, s.cmd, s.args); s.cmd = -1; s.args = []; }
      } else if (ARGS[b]) { s.cmd = b; s.args = []; }
      else command(s, b, []);
      if (!s.stream) s.expectControl = true;
      return true;
    },
    read(chip) {
      // status read: bit 6 = display off
      return chip.state.on ? 0x00 : 0x40;
    },
    stop(chip) {
      const s = chip.state;
      if (!s.dirty) return;
      s.dirty = false;
      s.updates++;
      const art = render(s);
      if (art !== s.ascii) {
        s.ascii = art;
        if (s.lastLog < 0 || chip.time - s.lastLog >= 0.1) {
          s.lastLog = chip.time;
          chip.log('SSD1306 display update #' + s.updates + ':\n' + art);
        }
      }
    },
  },
};
`;
