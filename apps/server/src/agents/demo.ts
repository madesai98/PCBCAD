import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProviderStatus } from '@pcbcad/core';
import { REPO_ROOT } from '../config';
import { McpStdioClient } from './mcp-client';
import type { AgentEvent, ProviderAdapter, TurnOutcome, TurnRequest } from './types';

/**
 * Scripted demo agent. It needs no LLM: it drives the real PCBCAD MCP server (through the same
 * stdio proxy the CLIs use) along a fixed design script, so the whole pipeline — distributor
 * parts, schematic, layout, multi-board cable, firmware emulation, enclosure, sheet metal,
 * simulations and export — can be demonstrated and tested end to end.
 */
export class DemoAdapter implements ProviderAdapter {
  id = 'demo' as const;
  name = 'Demo agent (scripted)';
  reportsToolCalls = true;

  async detect(): Promise<ProviderStatus> {
    return {
      id: this.id,
      name: this.name,
      available: true,
      version: 'built-in',
      models: [{ id: 'scripted', label: 'Scripted walkthrough', description: 'No LLM — replays a full product design using the real tools' }],
      defaultModel: 'scripted',
    };
  }

  async runTurn(req: TurnRequest, emit: (e: AgentEvent) => void): Promise<TurnOutcome> {
    const client = new McpStdioClient(req.mcp.command, req.mcp.args, req.mcp.env);
    const ctx = new DemoContext(client, emit, req.signal);
    try {
      await client.initialize();
      emit({ type: 'session', sessionId: `demo-${randomUUID()}` });
      const overview = await client.call('get_design_overview', {});
      const empty = /Boards \(0\)/.test(overview.text);
      const p = req.prompt.toLowerCase();
      if (empty || /\b(demo|build|design|sensor|everything|full)\b/.test(p)) {
        if (!empty) {
          await ctx.say('This project already has a design. I am the scripted demo agent, so I will re-run the verification steps instead of redesigning. For open-ended design work, pick Claude Code, Codex or Gemini as the agent.');
          await verify(ctx);
        } else await buildDemoProduct(ctx);
      } else if (/drc|route/.test(p)) await ctx.step('Running the design-rule check on every board.', async () => {
        for (const b of boardsFrom(overview.text)) await ctx.call('run_drc', { boardId: b });
      });
      else if (/thermal|heat|temp/.test(p)) await ctx.step('Running thermal simulations.', async () => {
        for (const b of boardsFrom(overview.text)) await ctx.call('simulate_pcb_thermal', { boardId: b });
      });
      else if (/drop|impact/.test(p)) await ctx.step('Dropping the product from 1.2 m onto concrete.', () => ctx.call('simulate_drop', { heightM: 1.2, orientation: 'bottom', floor: 'concrete' }));
      else if (/air|flow|vent|cfd/.test(p)) await ctx.step('Simulating airflow and heat inside the enclosure.', () => ctx.call('simulate_airflow', {}));
      else if (/firmware|emulat|uart/.test(p)) await ctx.step('Running the firmware in the emulator.', () => ctx.call('run_firmware_simulation', { duration: 1.5, environment: { temperatureC: 24.5, pressurePa: 100800, humidityPct: 41 } }));
      else if (/export|gerber|manufactur/.test(p)) await ctx.step('Generating the manufacturing package.', () => ctx.call('export_manufacturing', {}));
      else if (/dfm|mold|sheet/.test(p)) await ctx.step('Checking manufacturability.', () => ctx.call('run_dfm', {}));
      else {
        await ctx.say(
          "I'm the built-in scripted demo agent — I don't understand free-form requests. Ask me to **build the demo**, or to run **DRC**, **thermal**, **drop**, **airflow**, **firmware** or **export**. For real design work, switch the agent to Claude Code, Codex or Gemini (installed CLIs are detected automatically).\n\nCurrent design:\n\n```\n" +
            overview.text.slice(0, 1800) +
            '\n```',
        );
      }
      return { status: 'completed' };
    } catch (e) {
      if (req.signal.aborted) return { status: 'interrupted' };
      return { status: 'failed', error: e instanceof Error ? e.message : String(e) };
    } finally {
      client.close();
    }
  }
}

function boardsFrom(overview: string): string[] {
  return [...overview.matchAll(/^\s+- .+? \[(brd_[a-z0-9]+)\]/gm)].map((m) => m[1]);
}

class DemoContext {
  constructor(
    readonly client: McpStdioClient,
    private emit: (e: AgentEvent) => void,
    private signal: AbortSignal,
  ) {}

  checkAbort() {
    if (this.signal.aborted) throw new Error('aborted');
  }

  async say(text: string) {
    this.checkAbort();
    const id = randomUUID();
    const words = text.split(/(\s+)/);
    let acc = '';
    for (let i = 0; i < words.length; i++) {
      acc += words[i];
      if (i % 6 === 5 || i === words.length - 1) {
        this.emit({ type: 'text.delta', id, delta: acc });
        acc = '';
        await sleep(25);
      }
    }
    this.emit({ type: 'text.done', id, text });
  }

  async call(name: string, args: Record<string, unknown>): Promise<string> {
    this.checkAbort();
    const callId = randomUUID();
    this.emit({ type: 'tool.start', callId, name: `mcp__pcbcad__${name}`, input: args });
    try {
      const r = await this.client.call(name, args);
      this.emit({ type: 'tool.done', callId, output: r.text, isError: r.isError });
      return r.isError ? `ERROR: ${r.text}` : r.text;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.emit({ type: 'tool.done', callId, output: msg, isError: true });
      return `ERROR: ${msg}`;
    }
  }

  async step(intro: string, fn: () => Promise<unknown>) {
    await this.say(intro);
    try {
      await fn();
    } catch (e) {
      if (this.signal.aborted) throw e;
      await this.say(`That step hit a problem (${e instanceof Error ? e.message : e}); continuing with the rest of the flow.`);
    }
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function firstLine(s: string) {
  return s.split('\n').find((l) => l.trim())?.trim() ?? '';
}

function line(s: string, re: RegExp) {
  return s.split('\n').find((l) => re.test(l))?.trim() ?? '';
}

const FALLBACK_FIRMWARE = `#include <avr/io.h>
#include <util/delay.h>
#include <stdio.h>
static int uart_putc(char c, FILE *f) { (void)f; while (!(UCSR0A & (1 << UDRE0))); UDR0 = c; return 0; }
static FILE out = FDEV_SETUP_STREAM(uart_putc, NULL, _FDEV_SETUP_WRITE);
int main(void) {
  UCSR0A = (1 << U2X0); UBRR0 = (F_CPU / 8 / 115200) - 1; UCSR0B = (1 << TXEN0); UCSR0C = (3 << UCSZ00);
  stdout = &out; DDRB |= (1 << PB5);
  printf("PCBCAD demo firmware\\r\\n");
  for (uint16_t n = 0;; n++) { PORTB ^= (1 << PB5); printf("tick %u\\r\\n", n); _delay_ms(250); }
}
`;

function firmwareSource(): { source: string; real: boolean } {
  const f = path.join(REPO_ROOT, 'examples', 'firmware', 'env-sensor', 'main.c');
  if (fs.existsSync(f)) return { source: fs.readFileSync(f, 'utf8'), real: true };
  return { source: FALLBACK_FIRMWARE, real: false };
}

/* ----------------------------------------- the demo script ----------------------------------------- */

async function buildDemoProduct(ctx: DemoContext) {
  await ctx.say(
    "I'll design a complete product end to end: **a USB-C powered environmental monitor** with a remote BME280 probe on a cable, an ATmega328P running real firmware, an injection-molded PC/ABS enclosure and an aluminium wall-mount bracket. Every part comes from the JLCPCB/LCSC catalogue, and I'll verify the design with circuit, thermal, firmware, structural, drop and airflow simulations.",
  );
  await ctx.step('First, the requirements.', () =>
    ctx.call('set_project_info', {
      name: 'Environmental Monitor',
      description: 'USB-C powered temperature/humidity/pressure monitor with a remote probe, wall mountable.',
      requirements: [
        'Power: USB-C 5 V, < 50 mA typical',
        'Measure temperature (±0.5 °C), humidity and pressure with a remote probe on a 150 mm cable',
        'Status LEDs; serial console at 115200 baud',
        'Injection-molded enclosure, wall-mount bracket, survive a 1.2 m drop',
        'Ambient 0–40 °C; build quantity 500',
      ],
      buildQuantity: 500,
      ambientC: 25,
    }),
  );

  await ctx.step('Checking that the key parts are in stock at JLCPCB/LCSC.', async () => {
    const r1 = await ctx.call('search_parts', { query: 'ATMEGA328P-AU', limit: 3 });
    const r2 = await ctx.call('search_parts', { query: 'BME280', limit: 3 });
    await ctx.say(`Both are stocked: ${line(r1, /C14877/).split('|').slice(0, 5).join('|')} and ${line(r2, /C92489/).split('|').slice(0, 5).join('|')}.`);
  });

  await ctx.step('Creating the main board (50 × 35 mm, 2-layer) and the probe board (22 × 16 mm).', async () => {
    await ctx.call('create_board', { name: 'Main', width: 50, height: 35, cornerRadius: 2, description: 'MCU, power, LEDs, probe connector' });
    await ctx.call('create_board', { name: 'Probe', width: 22, height: 16, cornerRadius: 1.5, maskColor: 'black', description: 'BME280 environmental sensor probe' });
  });

  await ctx.step(
    'Placing the main-board parts: USB-C receptacle, SS34 reverse-polarity Schottky, AMS1117-3.3 LDO with 10 µF caps, the ATmega328P (running from its internal 8 MHz oscillator at 3.3 V, so no crystal is needed), decoupling, reset pull-up, two status LEDs, I²C pull-ups, a JST-PH probe connector and a UART header.',
    () =>
      ctx.call('add_components', {
        boardId: 'Main',
        components: [
          { part: 'C165948', ref: 'J1', group: 'power' },
          { part: 'C8678', ref: 'D1', group: 'power' },
          { part: 'C6186', ref: 'U1', group: 'power' },
          { part: 'C15850', ref: 'C1', group: 'power' },
          { part: 'C15850', ref: 'C2', group: 'power' },
          { part: 'C17414', ref: 'R6', value: '5.1k', group: 'power' },
          { part: 'C17414', ref: 'R7', value: '5.1k', group: 'power' },
          { part: 'C14877', ref: 'U2', group: 'mcu' },
          { part: 'C49678', ref: 'C3', group: 'mcu' },
          { part: 'C49678', ref: 'C4', group: 'mcu' },
          { part: 'C49678', ref: 'C5', group: 'mcu' },
          { part: 'C17414', ref: 'R1', group: 'mcu' },
          { part: 'C2297', ref: 'D2', group: 'ui' },
          { part: 'C17513', ref: 'R2', group: 'ui' },
          { part: 'C2286', ref: 'D3', group: 'ui' },
          { part: 'C17513', ref: 'R3', group: 'ui' },
          { part: 'C17673', ref: 'R4', group: 'i2c' },
          { part: 'C17673', ref: 'R5', group: 'i2c' },
          { part: 'C131334', ref: 'J2', group: 'probe' },
          { part: 'C124378', ref: 'J3', group: 'debug' },
        ],
      }),
  );

  await ctx.step('Wiring the main-board schematic. The USB-C CC pins get 5.1 k pull-downs so a charger supplies 5 V; the I²C bus gets 4.7 k pull-ups to 3V3.', () =>
    ctx.call('connect', {
      boardId: 'Main',
      nets: [
        { net: 'VBUS', pins: ['J1.VBUS', 'D1.A'] },
        { net: 'GND', pins: ['J1.GND', 'J1.EH', 'U1.GND', 'C1.2', 'C2.2', 'C3.2', 'C4.2', 'C5.2', 'U2.GND', 'R6.2', 'R7.2', 'D2.K', 'D3.K', 'J2.2', 'J3.1'] },
        { net: '5V', pins: ['D1.K', 'U1.VIN', 'C1.1'] },
        { net: '3V3', pins: ['U1.VOUT', 'C2.1', 'U2.VCC', 'U2.AVCC', 'C3.1', 'C4.1', 'C5.1', 'R1.1', 'R4.1', 'R5.1', 'J2.1', 'J3.2'] },
        { net: 'CC1', pins: ['J1.CC1', 'R6.1'] },
        { net: 'CC2', pins: ['J1.CC2', 'R7.1'] },
        { net: 'RESET', pins: ['U2.PC6', 'R1.2'] },
        { net: 'LED_STATUS', pins: ['U2.PB5', 'R2.1'] },
        { net: 'LED_STATUS_K', pins: ['R2.2', 'D2.A'] },
        { net: 'LED_ALERT', pins: ['U2.PD6', 'R3.1'] },
        { net: 'LED_ALERT_K', pins: ['R3.2', 'D3.A'] },
        { net: 'I2C_SDA', pins: ['U2.PC4', 'R4.2', 'J2.3'] },
        { net: 'I2C_SCL', pins: ['U2.PC5', 'R5.2', 'J2.4'] },
        { net: 'UART_TX', pins: ['U2.PD1', 'J3.3'] },
        { net: 'UART_RX', pins: ['U2.PD0', 'J3.4'] },
      ],
    }),
  );

  await ctx.step('The product is powered from a USB-C charger, so I declare J1.VBUS as an external 5 V supply (50 mΩ source resistance, 3 A) — simulations use it as the power source.', () =>
    ctx.call('set_external_supply', { boardId: 'Main', ref: 'J1', supplies: [{ pin: 'VBUS', V: 5, Rint: 0.05, Imax: 3, name: 'USB-C charger' }] }),
  );

  await ctx.step('Now the probe: a matching JST-PH connector, the BME280 in I²C mode (CSB high, SDO low → address 0x76) and its decoupling capacitor.', async () => {
    await ctx.call('add_components', {
      boardId: 'Probe',
      components: [
        { part: 'C131334', ref: 'J1' },
        { part: 'C92489', ref: 'U1' },
        { part: 'C49678', ref: 'C1' },
      ],
    });
    await ctx.call('connect', {
      boardId: 'Probe',
      nets: [
        { net: '3V3', pins: ['J1.1', 'U1.VDD', 'U1.VDDIO', 'U1.CSB', 'C1.1'] },
        { net: 'GND', pins: ['J1.2', 'U1.GND', 'U1.SDO', 'C1.2'] },
        { net: 'I2C_SDA', pins: ['J1.3', 'U1.SDI'] },
        { net: 'I2C_SCL', pins: ['J1.4', 'U1.SCK'] },
      ],
    });
  });

  await ctx.step('Making the JST-PH headers functional connectors (mate with PHR-4 housings, 2 A per contact) and cabling the boards with real crimp parts: 2 × PHR-4 housings, 8 × SPH-002T-P0.5S terminals and 150 mm of AWG26.', async () => {
    await ctx.call('configure_connector', {
      partId: 'C131334',
      family: 'JST-PH',
      gender: 'male',
      role: 'board',
      positions: 4,
      pitch: 2,
      matesWith: ['JST-PH:female', 'C111514'],
      contactResistance: 0.02,
      currentRating: 2,
      voltageRating: 100,
      matingDirection: '+y',
      opening: { width: 10.5, height: 6.5, zCenter: 3 },
    });
    await ctx.call('define_part', {
      id: 'C111514',
      mpn: 'PHR-4',
      manufacturer: 'JST',
      description: 'PH series 4-position crimp housing, 2.0 mm pitch',
      category: 'connector',
      package: 'P=2mm',
      pins: [
        { number: '1', name: '1' },
        { number: '2', name: '2' },
        { number: '3', name: '3' },
        { number: '4', name: '4' },
      ],
      offers: [{ distributor: 'LCSC', sku: 'C111514', url: 'https://www.lcsc.com/product-detail/C111514.html' }],
      connector: { family: 'JST-PH', gender: 'female', role: 'cable', positions: 4, pitch: 2, matesWith: ['JST-PH:male'], contactResistance: 0.02, currentRating: 2 },
    });
    await ctx.call('define_part', {
      id: 'C111515',
      mpn: 'SPH-002T-P0.5S',
      manufacturer: 'JST',
      description: 'PH crimp terminal, AWG 24–30',
      category: 'connector',
      package: 'crimp',
      pins: [{ number: '1', name: '1' }],
      offers: [{ distributor: 'LCSC', sku: 'C111515', url: 'https://www.lcsc.com/product-detail/C111515.html' }],
    });
    const r = await ctx.call('connect_boards', {
      name: 'Probe cable',
      kind: 'cable',
      a: { board: 'Main', ref: 'J2' },
      b: { board: 'Probe', ref: 'J1' },
      mapping: 'straight',
      length: 150,
      awg: 26,
      cableParts: [
        { part: 'C111514', qty: 2 },
        { part: 'C111515', qty: 8 },
      ],
    });
    await ctx.say(firstLine(r));
  });

  await ctx.step('Electrical rule check on both boards.', async () => {
    const a = await ctx.call('run_erc', { boardId: 'Main' });
    const b = await ctx.call('run_erc', { boardId: 'Probe' });
    const errs = (a + b).split('\n').filter((l) => l.startsWith('[error]')).length;
    await ctx.say(errs ? `ERC reports ${errs} error(s); the remaining items are informational for unused MCU pins.` : 'ERC is clean apart from informational notes (unused MCU pins are intentionally left open).');
  });

  await ctx.step('Laying out the boards: M3 mounting holes in the corners of the main board, USB-C on the left edge, probe connector on the right, UART header at the bottom; a ground pour on both layers, then autorouting.', async () => {
    await ctx.call('add_mounting_holes', { boardId: 'Main', preset: 'corners', inset: 3.5, drill: 3.2 });
    await ctx.call('auto_place', { boardId: 'Main', edges: [{ ref: 'J1', edge: 'left' }, { ref: 'J2', edge: 'right' }, { ref: 'J3', edge: 'bottom' }] });
    await ctx.call('add_zone', { boardId: 'Main', net: 'GND', layer: 'bottom' });
    await ctx.call('add_zone', { boardId: 'Main', net: 'GND', layer: 'top', clearance: 0.3 });
    const r = await ctx.call('auto_route', { boardId: 'Main', skipNets: ['GND'] });
    await ctx.say(firstLine(r));
    await ctx.call('add_mounting_holes', { boardId: 'Probe', holes: [{ x: 3, y: 8 }], drill: 2.2 });
    await ctx.call('auto_place', { boardId: 'Probe', edges: [{ ref: 'J1', edge: 'left' }] });
    await ctx.call('add_zone', { boardId: 'Probe', net: 'GND', layer: 'bottom' });
    const r2 = await ctx.call('auto_route', { boardId: 'Probe', skipNets: ['GND'] });
    await ctx.say(firstLine(r2));
  });

  await ctx.step('Simulating the whole system (both boards + cable) at DC to check rails, currents and component derating.', async () => {
    const r = await ctx.call('simulate_circuit', { target: 'system', analysis: 'op' });
    await ctx.say(`${firstLine(r)}. ${line(r, /^Rails:/)}`);
  });

  await ctx.step('Thermal simulation of the main board (natural convection, 25 °C ambient, power from the circuit solution).', async () => {
    const r = await ctx.call('simulate_pcb_thermal', { boardId: 'Main' });
    await ctx.say(firstLine(r));
  });

  await ctx.step('Firmware-in-the-loop: compiling the environment-monitor firmware for the ATmega328P (8 MHz), attaching the BME280 behaviour model to the probe sensor, and running 2 s of emulated time at 24.5 °C / 1008 hPa / 41 %RH.', async () => {
    const fw = firmwareSource();
    const b = await ctx.call('build_firmware', { name: 'env-monitor', mcu: 'atmega328p', fCpu: 8000000, sources: { 'main.c': fw.source }, assign: { boardId: 'Main', ref: 'U2' } });
    if (b.startsWith('ERROR')) return;
    await ctx.call('write_behavior_script', { name: 'BME280 model', builtin: 'builtin:bme280', assign: [{ boardId: 'Probe', ref: 'U1' }] });
    const r = await ctx.call('run_firmware_simulation', { target: 'system', duration: 2, environment: { temperatureC: 24.5, pressurePa: 100800, humidityPct: 41 } });
    const uart = r.split('\n').filter((l) => /T=|id=|BME|hello|tick/i.test(l)).slice(0, 4);
    await ctx.say(`${firstLine(r)}.${uart.length ? ` Serial console:\n\n\`\`\`\n${uart.join('\n')}\n\`\`\`` : ''}`);
  });

  let encl = { w: 0, d: 0, h: 0, baseId: '' };
  await ctx.step('Designing the enclosure: a two-part PC/ABS injection-molded housing around the main board — heat-set-insert bosses under the mounting holes, M3 case screws, a USB-C cut-out, a cable exit for the probe, and vent slots in the top and bottom (a natural-convection chimney that molds without side actions).', async () => {
    const r = await ctx.call('create_enclosure', {
      boardIds: ['Main'],
      materialId: 'pc-abs',
      process: 'injection-molding',
      wall: 2,
      clearance: 1,
      insert: 'heat-set',
      ventFaces: ['top', 'bottom'],
      color: '#e8e6e1',
      screwPart: 'fastener:iso7380-m3x8',
      insertPart: 'fastener:insert-m3x5.7-od4.6',
    });
    const m = /Enclosure base \[(mech_[a-z0-9]+)\] base: ([\d.]+)×([\d.]+)×([\d.]+) mm/.exec(r);
    const c = /cover: [\d.]+×[\d.]+×([\d.]+) mm/.exec(r);
    if (m) encl = { baseId: m[1], w: +m[2], d: +m[3], h: +m[4] + (c ? +c[1] : 0) };
    await ctx.say(r.split('\n').slice(1, 3).join(' '));
  });

  await ctx.step('Adding a 1.5 mm aluminium 5052-H32 wall bracket, anodised black: the enclosure sits on its shelf and is screwed up into two new heat-set-insert bosses in the base; the upright flange screws to the wall.', async () => {
    if (!encl.baseId) return;
    const t = 1.5;
    const len = 16;
    const yc = encl.d / 2 + 0.2 + t - len / 2; // flange inner face 0.2 mm behind the enclosure's back face
    const z0 = -(t + 0.2);
    await ctx.call('create_sheet_metal_part', {
      name: 'Wall bracket',
      materialId: 'al-5052-h32',
      thickness: t,
      base: { width: 40, length: len },
      flanges: [{ edge: '+y', length: Math.round(encl.h + 5), angle: 90, holes: [{ x: -12, y: Math.round(encl.h * 0.7), diameter: 4.5 }, { x: 12, y: Math.round(encl.h * 0.7), diameter: 4.5 }] }],
      holes: [
        { x: -10, y: -2, diameter: 3.4 },
        { x: 10, y: -2, diameter: 3.4 },
      ],
      finish: 'anodized-black',
      position: [0, yc, z0],
    });
    const yb = yc - 2;
    for (const x of [-10, 10])
      await ctx.call('add_shell_feature', { partId: encl.baseId, type: 'boss', params: { x, y: yb, outerDiameter: 8, holeDiameter: 4, height: 5, kind: 'insert', throughFloor: true, gussets: 2, fastenerPartId: 'fastener:insert-m3x4-od4.6' } });
    await ctx.call('add_fastener', { part: 'fastener:insert-m3x4-od4.6', position: [-10, yb, 7], positions: [[10, yb, 7]], direction: [0, 0, -1], note: 'Bracket inserts' });
    await ctx.call('add_fastener', { part: 'fastener:iso7380-m3x8', position: [-10, yb, z0], positions: [[10, yb, z0]], direction: [0, 0, 1], note: 'Bracket to enclosure' });
  });

  await ctx.step('Manufacturability review of the molded shells, the bracket and the assembly.', async () => {
    const r = await ctx.call('run_dfm', {});
    const errors = r.split('\n').filter((l) => l.startsWith('[error]')).length;
    const warns = r.split('\n').filter((l) => l.startsWith('[warning]')).length;
    await ctx.say(`DFM: ${errors} error(s), ${warns} warning(s). The details are in the Issues list for review.`);
  });

  await ctx.step('Structural check of the bracket: wall flange fixed, 20 N downward load (≈ 4× the product weight with margin) on the base.', async () => {
    const ov = await ctx.client.call('get_design_overview', {});
    const id = /Wall bracket \[(mech_[a-z0-9]+)\]/.exec(ov.text)?.[1];
    if (!id) return;
    const r = await ctx.call('simulate_structural', {
      partIds: [id],
      fixtures: [{ kind: 'face', face: '+y', depth: 2 }],
      loads: [{ kind: 'force', region: { kind: 'box', min: [-20, -8, 0], max: [20, 0, 1.5] }, vector: [0, 0, -20] }],
    });
    await ctx.say(firstLine(r));
  });

  await ctx.step('Drop test: 1.2 m onto concrete, landing flat on the base.', async () => {
    const r = await ctx.call('simulate_drop', { heightM: 1.2, orientation: 'bottom', floor: 'concrete' });
    await ctx.say(firstLine(r));
  });

  await ctx.step('Airflow and enclosure heating (natural convection through the vent slots).', async () => {
    const r = await ctx.call('simulate_airflow', {});
    await ctx.say(firstLine(r));
  });

  await ctx.step('Cost estimate and the manufacturing package (Gerbers, drills, BOM, pick-and-place, STL, DXF).', async () => {
    const c = await ctx.call('estimate_cost', {});
    await ctx.say(line(c, /^Total/));
    const e = await ctx.call('export_manufacturing', {});
    await ctx.say(firstLine(e));
  });

  await ctx.call('add_design_note', {
    title: 'Demo design summary',
    text: 'Main board: USB-C → SS34 → AMS1117-3.3 → ATmega328P @ 8 MHz internal RC. Probe: BME280 over I²C via JST-PH cable. Enclosure: PC/ABS injection molded with heat-set inserts. Bracket: Al 5052-H32 1.5 mm, anodised. Verified by circuit OP, PCB thermal, firmware emulation, DFM, structural, drop and airflow simulation.',
    tags: ['demo'],
  });
  await ctx.say(
    "Done. Review the result in the workspace tabs: **Schematic** and **PCB** for each board, **3D** for the full assembly (try the explode slider and x-ray), **Simulations** for the waveforms, heat maps, stress plots and serial console, and **Manufacturing** for DFM issues and the export. Ask for any change — or switch to Claude Code / Codex / Gemini for open-ended design work.",
  );
}

async function verify(ctx: DemoContext) {
  const ov = await ctx.client.call('get_design_overview', {});
  for (const b of boardsFrom(ov.text)) {
    await ctx.call('run_drc', { boardId: b });
    await ctx.call('simulate_pcb_thermal', { boardId: b });
  }
  if (/Mechanical \(/.test(ov.text)) await ctx.call('run_dfm', {});
  await ctx.say('Verification re-run complete — see the Issues and Simulations tabs.');
}
