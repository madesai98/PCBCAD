import type { PartCategory } from '@pcbcad/core';

/**
 * Category inference from distributor taxonomy, description and MPN.
 *
 * JLCPCB/LCSC send a specific category ("Chip Resistor - Surface Mount", "Schottky Diodes") and a
 * parent ("Resistors", "Diodes"). Rules are tried on the specific name first, then the parent, then
 * the free-text description and finally well-known MPN prefixes. Rule order matters: specific
 * patterns ("LED Drivers", "Screw Terminal Blocks", "DC-DC Converters") precede generic ones.
 */

type Refiner = (ctx: string) => PartCategory;
type Rule = [RegExp, PartCategory | Refiner];

const mosfet: Refiner = (ctx) => (/\bp[- ]?(channel|ch)\b|\bpmos\b|p-mosfet/i.test(ctx) && !/\bn[- ]?(channel|ch)\b/i.test(ctx) ? 'mosfet-p' : 'mosfet-n');
const bjt: Refiner = (ctx) => (/\bpnp\b/i.test(ctx) && !/\bnpn\b/i.test(ctx) ? 'bjt-pnp' : 'bjt-npn');
const wire: Refiner = (ctx) =>
  /dupont|terminal wire|assembl|harness|jumper|\d+p\b|\bribbon|flat cable|ffc|multi.?core|\d+\s*c\b/i.test(ctx) ? 'cable' : 'wire';

/** Category-name rules (applied to the specific category, then the parent). */
const CATEGORY_RULES: Rule[] = [
  [/new arrivals|^smt$|^others?$/i, 'other'],
  [/accessor|enclosure|heat ?sink|thermal pad|cable tie|tool\b/i, 'mechanical'],
  [/development board|evaluation|dev(elopment)? kit/i, 'module'],
  [/display|\blcd\b|\boled\b|segment|e-?paper|e-?ink/i, 'display'],
  [/clock|timing|timer|\brtc\b|real.?time/i, 'ic'],
  [/led driver|gate driver|motor driver|display driver|\bdrivers?\b/i, 'driver'],
  [/optocoupler|optoisolator|photocoupler|opto.?isolat/i, 'ic'],
  [/photo ?(diode|transistor)|infrared receiver|ambient light|light sensor/i, 'sensor'],
  [/\bleds?\b|light emitting|led indication|led - |infrared emitter|laser diode/i, 'led'],
  [/test ?points?/i, 'testpoint'],
  [/fuse/i, 'fuse'],
  [/relay/i, 'relay'],
  [/^(?!.*(management|charg|protection|monitor|gauge|balanc)).*(batter(y|ies)|coin cell|cell holder)/i, 'battery'],
  [/buzzer|speaker|transducer|sounder/i, 'buzzer'],
  [/microphone/i, 'sensor'],
  [/antenna/i, 'antenna'],
  [/crystal|resonator/i, 'crystal'],
  [/oscillator|\bvcxo\b|\btcxo\b|\bxo\b/i, 'oscillator'],
  [/connectors?\b|headers?\b|housing|crimp|receptacle|\bjacks?\b|\bplugs?\b|ic sockets?|card sockets?|wire to board|board to board|\bffc\b|\bfpc\b|banana|binding post/i, 'connector'],
  [/electronic cable|hook.?up wire|\bwires?\b|\bcables?\b/i, wire],
  [/terminal blocks?|barrier block/i, 'connector'],
  [/fastener|standoff|spacer|washer|\bnuts?\b|threaded insert|insert nut|\bscrews?\b|\bbolts?\b|rivet|\bstuds?\b|hex stud/i, 'fastener'],
  [/\bfans?\b|blower/i, 'mechanical'],
  [/potentiometer|trimmer resistor|variable resistor|rheostat/i, 'resistor'],
  [/varistor|\btvs\b|\besd\b|surge|transient|discharge tube|\btss\b|gas discharge/i, 'tvs'],
  [/resistor|thermistor|\bntc\b|\bptc\b|shunt/i, 'resistor'],
  [/aluminum electrolytic|aluminium electrolytic|electrolytic|tantalum|polymer|supercapacitor|super capacitor|double layer|horn-type|niobium/i, 'capacitor-polarized'],
  [/capacitor|\bmlcc\b/i, 'capacitor'],
  [/ferrite/i, 'ferrite'],
  [/inductor|\bcoils?\b|choke/i, 'inductor'],
  [/schottky/i, 'schottky'],
  [/zener/i, 'zener'],
  [/diode|rectifier/i, 'diode'],
  [/mosfet|field effect|\bjfet\b|\bfets?\b|\bigbt\b|\bgan\b|gallium nitride/i, mosfet],
  [/\bbjt\b|bipolar|darlington|digital transistor|pre-?biased/i, bjt],
  [/thyristor|triac|\bscr\b|\bdiac\b/i, 'other'],
  [/\bldo\b|low drop ?out|linear (voltage )?regulator|linear regulator/i, 'ldo'],
  [/dc-?dc|switching regulator|buck|boost|step-?(down|up)|power modules?|charge pump/i, 'dc-dc'],
  [/fpga|cpld/i, 'ic'],
  [/microcontroller|\bmcu\b|\bmpu\b|\bsoc\b|embedded processor|\bdsp\b|microprocessor/i, 'mcu'],
  [/(wifi|wi-fi|bluetooth|\bble\b|wireless|\brf\b|lora|zigbee|gps|gnss|cellular|\blte\b|nb-?iot|4g|5g).*modules?|modules?.*(wifi|wi-fi|bluetooth|wireless|\brf\b|lora|zigbee|gnss|gps)/i, 'rf-module'],
  [/\brf\b|wireless/i, 'ic'],
  [/sensor|accelerometer|gyroscope|magnetometer|\bhall\b|\bimu\b|humidity|pressure|temperature and|thermocouple|proximity|encoder ic/i, 'sensor'],
  [/memory|eeprom|\bflash\b|\bsram\b|\bdram\b|\bfram\b|nvram|\bsdram\b/i, 'memory'],
  [/comparator/i, 'comparator'],
  [/rf amplifier|audio|power amplifier|class.?d/i, 'ic'],
  [/op ?amps?|operational amplifier|instrumentation amplifier|amplifier/i, 'opamp'],
  [/usb converter|interface|transceiver|\buart\b|rs-?485|rs-?232|rs-?422|\bcan\b|ethernet|\bphy\b|isolator|i\/o expander|\blvds\b|hdmi|usb (hub|controller)|level (shifter|translator)/i, 'interface'],
  [/analog switch/i, 'ic'],
  [/rotary (encoder|switch|coding)|encoder switch|\bencoders?\b/i, 'switch'],
  [/logic|\bgates?\b|flip.?flop|latch|shift register|buffer|inverter|multiplexer|decoder|counter/i, 'logic'],
  [/tactile|push ?button|\bbuttons?\b/i, 'button'],
  [/switch/i, 'switch'],
  [/modules?\b/i, 'module'],
  [/voltage reference|power management|pmic|battery management|charger|supervisor|load switch|power switch|regulator/i, 'ic'],
  [/\bics?\b|integrated circuit|converter|data acquisition|\badc\b|\bdac\b|codec/i, 'ic'],
  [/transistor/i, bjt],
];

/** Well-known MPN prefixes (used when the taxonomy is missing or generic). */
const MPN_RULES: Rule[] = [
  [/^(ESP32-(WROOM|WROVER|MINI|C3-MINI|S3-WROOM|C3-WROOM|C6-WROOM)|ESP-\d|ESP8266-|ESP-WROOM|RAK|E\d{2}-|HC-0[56]|NRF52\d+-MOD)/, 'rf-module'],
  [/^(ATMEGA|ATTINY|ATSAM|ATXMEGA|STM32|STM8|GD32|CH32|CH55|PIC1[0268]|PIC24|PIC32|DSPIC|NRF5[0-9]|RP2040|RP2350|ESP32|ESP8266|SAMD|MSP430|EFM32|LPC\d|MKL|MK\d|PY32|HC32|N76E|STC\d)/, 'mcu'],
  [/^(AMS1117|LM1117|AP2112|AP2127|AP7333|AP7361|XC6206|XC6210|XC6220|ME6211|ME6206|RT9013|RT9193|HT7[0-9]{3}|LD1117|LD3985|LP5907|LP2985|MCP1700|MCP1702|MCP1703|MCP1711|MCP1725|TLV7[0-9]{2}|TLV1117|NCP1117|SPX3819|MIC5219|MIC5504|LM78|L78|LM79|L79|78L|79L|LM317|LM337|TPS7)/, 'ldo'],
  [/^(MP1584|MP2307|MP2359|MP1470|MP2451|LM2596|LM2576|LM2675|TPS5|TPS6|TPS56|TPS62|TPS61|SY8\d|MT3608|MT2492|AP3012|AP63|XL\d{4}|SX1308|RT8059|RT6|LMR\d|TLV62|ME3116|TP4056)/, 'dc-dc'],
  [/^(LM358|LM324|LM321|LMV3|OPA|TL07|TL08|TLV2|TLV9|MCP60|MCP6\d|NE5532|AD86|ADA48|LMC6|SGM8)/, 'opamp'],
  [/^(LM393|LM339|LM311|TLV3\d{2}|MCP65)/, 'comparator'],
  [/^(AO3401|AO3407|AO3423|AO4407|AO4435|SI2301|SI2305|SI2343|BSS84|DMP|IRLML6402|IRLML2244|IRLML9301|NTR1P|FDN3[0-9]{2}P|PMV[0-9]+UP|CJ2301|WPM)/, 'mosfet-p'],
  [/^(BSS138|AO3400|AO3402|AO3404|AO3406|AO3414|AO3416|2N7002|IRLML|IRF|IRL|SI230|DMG|DMN|NCE|FDN|FDS|NTR|AON|AOD|WSF|CJ34|BUK|PSMN|NVMFS|SQ2)/, 'mosfet-n'],
  [/^(1N414|1N400|1N540|LL4148|BAV|BAS|M7\b|US1|RS1|ES1|FR10|UF400)/, 'diode'],
  [/^(SS[1-9][0-9]|B5819|1N58|BAT|SK[1-9][0-9]|MBR|RB5|PMEG|SB[1-9])/, 'schottky'],
  [/^(BZT|BZX|MMSZ|MM3Z|1N47|1N52|BZV)/, 'zener'],
  [/^(SMAJ|SMBJ|SMCJ|P6KE|P4SMA|SMF|ESD|PESD|TPD|USBLC|SRV05|PRTR|SP05|LESD)/, 'tvs'],
  [/^(MMBT3904|2N3904|S8050|SS8050|BC8[0-9]7|BC5[0-9]7|MMBT2222|2N2222|S9013|S9014|MMBT4401|BC846|BC847|BC848|PMBT3904)/, 'bjt-npn'],
  [/^(MMBT3906|2N3906|S8550|SS8550|S9012|MMBT4403|BC856|BC857|BC858|PMBT3906|BC807|BC327)/, 'bjt-pnp'],
  [/^(CH340|CH341|CH343|CH9102|CP210|FT232|FT230|FT231|FT2232|MAX232|MAX3232|SP3232|MAX485|MAX3485|SP3485|SN65HVD|TJA10|MCP2551|MCP2515|ADUM|ISO77|TUSB|USB2514|W5500|ENC28|LAN87)/, 'interface'],
  [/^(BME|BMP|BMI|BMA|BMM|SHT|SHTC|AHT|DHT|HDC|LIS|LSM|MPU|ICM|ADXL|MMC|QMC|HMC|INA2|INA1|ACS7|TMP1|DS18|LM75|MAX3185|VEML|APDS|OPT3|TSL|VL53|SGP|SCD|CCS811|ENS1|MS5611|LPS)/, 'sensor'],
  [/^(W25Q|W25N|AT24|24C|24LC|25LC|AT25|MX25|GD25|IS25|IS62|IS42|AS6C|23LC|FM25|MB85|PY25)/, 'memory'],
  [/^(SN74|74HC|74LV|74AHC|74LVC|74AC|74HCT|CD40|CD45|NC7S|SN74LVC|TXB0|TXS0)/, 'logic'],
  [/^(NE555|LM555|ICM7555|DS3231|DS1307|PCF85|RV-)/, 'ic'],
  [/^(DRV8|A4988|TMC2|L298|L293|TB6612|ULN200|IR21|UCC27|WS2811|TLC59|TPIC)/, 'driver'],
  [/^(WS2812|SK6812|APA102)/, 'led'],
  [/^(B\d+B-|S\d+B-|SM\d+B-|BM\d+B-|PHR-|XHP-|SHR-|SPH-|SXH-|SSH-|TYPE-C|USB-|MICRO-USB|KF|DB\d{3}|WJ\d|XH-|PH-|HDR-|PZ254|KH-|HX|A\d{4}[A-Z]{0,2}-|DF1[0-9]|DF13|DF52|FPC-|FFC-)/, 'connector'],
  [/^(TS-|K2-|TL\d{4}|PTS|EVQ|SKRP|B3F|B3U|KMR)/, 'button'],
  [/^(SK12|SS12|MSK|PCM12|JS20|EG1|DSHP|SW-)/, 'switch'],
  [/^(X[0-9]{6}|ABM|ABLS|FA-|TSX-|HC-49|ECS-|NX\d|7A-|SC-?32S|FC-135)/, 'crystal'],
  [/^(SIT\d|DSC\d|ASE|ASCO|OSC)/, 'oscillator'],
  [/^(CR2032|CR2025|CR1220|LIR|BS-\d|BAT-HLD|KEYSTONE)/, 'battery'],
];

/** Description-only rules: conservative, only strong signals. */
const DESCRIPTION_RULES: Rule[] = [
  [/thick film resistor|thin film resistor|chip resistor|metal film resistor|\b\d+(\.\d+)?\s*[kmr]?(Ω|ohm)\b.*resistor|resistor network|shunt resistor/i, 'resistor'],
  [/multilayer ceramic|\bmlcc\b|\b(x7r|x5r|c0g|np0|y5v|x7s|x6s)\b/i, 'capacitor'],
  [/electrolytic|tantalum|polymer capacitor/i, 'capacitor-polarized'],
  [/ferrite bead/i, 'ferrite'],
  [/power inductor|shielded inductor|\binductor\b/i, 'inductor'],
  [/schottky/i, 'schottky'],
  [/zener/i, 'zener'],
  [/\btvs\b|esd protection|surge protection/i, 'tvs'],
  [/\bled\b|light emitting/i, 'led'],
  [/mosfet|n-channel|p-channel/i, mosfet],
  [/\bnpn\b|\bpnp\b|bipolar transistor/i, bjt],
  [/\bldo\b|low dropout|linear regulator/i, 'ldo'],
  [/step-?down|step-?up|buck|boost|dc-?dc/i, 'dc-dc'],
  [/microcontroller|\bmcu\b/i, 'mcu'],
  [/crystal\b/i, 'crystal'],
  [/oscillator/i, 'oscillator'],
  [/tactile switch|push button/i, 'button'],
  [/connector|pin header|female header|receptacle|wire to board|terminal block/i, 'connector'],
  [/\bdiode\b|rectifier/i, 'diode'],
  [/sensor/i, 'sensor'],
  [/op ?amp|operational amplifier/i, 'opamp'],
  [/comparator/i, 'comparator'],
  [/eeprom|flash memory|\bsram\b/i, 'memory'],
  [/transceiver|uart|usb to/i, 'interface'],
  [/standoff|screw|washer|\bnut\b|threaded insert/i, 'fastener'],
];

function applyRules(rules: Rule[], text: string, ctx: string): PartCategory | undefined {
  if (!text.trim()) return undefined;
  for (const [re, cat] of rules) {
    if (re.test(text)) return typeof cat === 'function' ? cat(ctx) : cat;
  }
  return undefined;
}

/**
 * Infer a PartCategory.
 * @param primary   Most specific distributor category (e.g. JLC 'firstSortName' "Schottky Diodes").
 * @param secondary Parent category ("Diodes"); optional.
 * @param description Free text (JLC 'describe' / LCSC intro); optional.
 * @param mpn       Manufacturer part number; optional.
 */
export function categorize(primary: string, secondary?: string, description?: string, mpn?: string): PartCategory {
  const ctx = [primary, secondary, description, mpn].filter(Boolean).join(' | ');
  for (const text of [primary, secondary ?? '']) {
    const c = applyRules(CATEGORY_RULES, text, ctx);
    // 'other' from junk taxonomies ("New Arrivals", "Others") falls through to text / MPN rules.
    if (c && c !== 'other') return c;
    if (c === 'other' && /thyristor|triac|\bscr\b|\bdiac\b/i.test(text)) return 'other';
  }
  const m = mpn ? applyRules(MPN_RULES, mpn.toUpperCase().trim(), ctx) : undefined;
  const d = description ? applyRules(DESCRIPTION_RULES, description, ctx) : undefined;
  // Prefer MPN knowledge for ICs whose descriptions are generic; description otherwise.
  if (m && (!d || d === 'ic' || d === 'diode' || d === 'sensor' || m === 'mcu' || m === 'rf-module' || m === 'ldo' || m === 'dc-dc')) return m;
  return d ?? m ?? 'other';
}
