/*
 * env-sensor — ATmega328P @ 16 MHz, avr-libc (no Arduino).
 *
 *  - USART0: 115200 8N1 with U2X (UBRR = 16), prints a banner, the BME280 chip id and then
 *    "T=23.41C P=1013.2hPa H=45.0%" every 500 ms.
 *  - BME280 on TWI (SDA = PC4, SCL = PC5, 100 kHz) at address 0x76 (SDO tied low):
 *    chip id, soft reset, calibration (0x88..0xA1, 0xE1..0xE7), forced-mode measurements
 *    (osrs_t = osrs_p = osrs_h = x1) and the Bosch datasheet integer compensation
 *    (32-bit temperature/humidity, 64-bit pressure).
 *  - Status LED on PB5 toggled once per loop.
 *  - Second LED on PD6 (OC0A) "breathing" via Timer0 fast PWM (976 Hz).
 *  - Timer1 CTC interrupt provides a 1 ms tick used to pace the loop.
 *
 * Build: make   (needs avr-gcc + avr-libc)
 */
#include <avr/interrupt.h>
#include <avr/io.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <util/atomic.h>
#include <util/delay.h>

#define BME280_ADDR 0x76
#define PERIOD_MS 500

/* ------------------------------------------------------------------ time base */

static volatile uint32_t g_millis;

ISR(TIMER1_COMPA_vect) { g_millis++; }

static uint32_t millis(void) {
  uint32_t m;
  ATOMIC_BLOCK(ATOMIC_RESTORESTATE) { m = g_millis; }
  return m;
}

static void timebase_init(void) {
  TCCR1A = 0;
  TCCR1B = _BV(WGM12) | _BV(CS11) | _BV(CS10); /* CTC, clk/64 */
  OCR1A = (F_CPU / 64 / 1000) - 1;             /* 249 -> 1 kHz */
  TIMSK1 = _BV(OCIE1A);
}

/* ------------------------------------------------------------------ UART */

static int uart_putchar(char c, FILE *f) {
  (void)f;
  loop_until_bit_is_set(UCSR0A, UDRE0);
  UDR0 = c;
  return 0;
}

static FILE uart_out = FDEV_SETUP_STREAM(uart_putchar, NULL, _FDEV_SETUP_WRITE);

static void uart_init(void) {
  UCSR0A = _BV(U2X0);
  UBRR0 = (F_CPU / 8 / 115200UL) - 1; /* 16 -> 117647 baud (-2.1 %), the usual Arduino setting */
  UCSR0B = _BV(TXEN0) | _BV(RXEN0);
  UCSR0C = _BV(UCSZ01) | _BV(UCSZ00); /* 8N1 */
  stdout = &uart_out;
}

/* ------------------------------------------------------------------ TWI (I2C master) */

static void twi_init(void) {
  TWSR = 0;                                /* prescaler 1 */
  TWBR = ((F_CPU / 100000UL) - 16) / 2;    /* 100 kHz */
  TWCR = _BV(TWEN);
}

static uint8_t twi_wait(void) {
  uint16_t guard = 0;
  while (!(TWCR & _BV(TWINT))) {
    if (++guard == 0) return 0; /* bus stuck */
  }
  return 1;
}

static uint8_t twi_start(uint8_t sla_rw) {
  TWCR = _BV(TWINT) | _BV(TWSTA) | _BV(TWEN);
  if (!twi_wait()) return 0;
  uint8_t st = TWSR & 0xF8;
  if (st != 0x08 && st != 0x10) return 0;
  TWDR = sla_rw;
  TWCR = _BV(TWINT) | _BV(TWEN);
  if (!twi_wait()) return 0;
  st = TWSR & 0xF8;
  return st == 0x18 || st == 0x40; /* SLA+W ACK / SLA+R ACK */
}

static void twi_stop(void) {
  TWCR = _BV(TWINT) | _BV(TWSTO) | _BV(TWEN);
  uint16_t guard = 0;
  while ((TWCR & _BV(TWSTO)) && ++guard) {
  }
}

static uint8_t twi_write(uint8_t b) {
  TWDR = b;
  TWCR = _BV(TWINT) | _BV(TWEN);
  if (!twi_wait()) return 0;
  return (TWSR & 0xF8) == 0x28;
}

static uint8_t twi_read(uint8_t ack) {
  TWCR = _BV(TWINT) | _BV(TWEN) | (ack ? _BV(TWEA) : 0);
  twi_wait();
  return TWDR;
}

/* ------------------------------------------------------------------ BME280 */

static uint8_t bme_read(uint8_t reg, uint8_t *buf, uint8_t n) {
  if (!twi_start(BME280_ADDR << 1) || !twi_write(reg) || !twi_start((BME280_ADDR << 1) | 1)) {
    twi_stop();
    return 0;
  }
  for (uint8_t i = 0; i < n; i++) buf[i] = twi_read(i + 1 < n);
  twi_stop();
  return 1;
}

static uint8_t bme_write(uint8_t reg, uint8_t val) {
  uint8_t ok = twi_start(BME280_ADDR << 1) && twi_write(reg) && twi_write(val);
  twi_stop();
  return ok;
}

static uint16_t dig_T1;
static int16_t dig_T2, dig_T3;
static uint16_t dig_P1;
static int16_t dig_P2, dig_P3, dig_P4, dig_P5, dig_P6, dig_P7, dig_P8, dig_P9;
static uint8_t dig_H1, dig_H3;
static int16_t dig_H2, dig_H4, dig_H5;
static int8_t dig_H6;
static int32_t t_fine;

static uint8_t bme_read_calibration(void) {
  uint8_t c[26], h[7];
  if (!bme_read(0x88, c, 26) || !bme_read(0xE1, h, 7)) return 0;
  dig_T1 = (uint16_t)(c[1] << 8 | c[0]);
  dig_T2 = (int16_t)(c[3] << 8 | c[2]);
  dig_T3 = (int16_t)(c[5] << 8 | c[4]);
  dig_P1 = (uint16_t)(c[7] << 8 | c[6]);
  dig_P2 = (int16_t)(c[9] << 8 | c[8]);
  dig_P3 = (int16_t)(c[11] << 8 | c[10]);
  dig_P4 = (int16_t)(c[13] << 8 | c[12]);
  dig_P5 = (int16_t)(c[15] << 8 | c[14]);
  dig_P6 = (int16_t)(c[17] << 8 | c[16]);
  dig_P7 = (int16_t)(c[19] << 8 | c[18]);
  dig_P8 = (int16_t)(c[21] << 8 | c[20]);
  dig_P9 = (int16_t)(c[23] << 8 | c[22]);
  dig_H1 = c[25]; /* 0xA1 */
  dig_H2 = (int16_t)(h[1] << 8 | h[0]);
  dig_H3 = h[2];
  dig_H4 = (int16_t)((int8_t)h[3] * 16) | (int16_t)(h[4] & 0x0F);
  dig_H5 = (int16_t)((int8_t)h[5] * 16) | (int16_t)(h[4] >> 4);
  dig_H6 = (int8_t)h[6];
  return 1;
}

/* Bosch BME280 datasheet, section 4.2.3: temperature in 0.01 degC. */
static int32_t bme_comp_T(int32_t adc_T) {
  int32_t var1, var2;
  var1 = ((((adc_T >> 3) - ((int32_t)dig_T1 << 1))) * ((int32_t)dig_T2)) >> 11;
  var2 = (((((adc_T >> 4) - ((int32_t)dig_T1)) * ((adc_T >> 4) - ((int32_t)dig_T1))) >> 12) * ((int32_t)dig_T3)) >> 14;
  t_fine = var1 + var2;
  return (t_fine * 5 + 128) >> 8;
}

/* Pressure in Pa as Q24.8 (64-bit version). */
static uint32_t bme_comp_P(int32_t adc_P) {
  int64_t var1, var2, p;
  var1 = ((int64_t)t_fine) - 128000;
  var2 = var1 * var1 * (int64_t)dig_P6;
  var2 = var2 + ((var1 * (int64_t)dig_P5) << 17);
  var2 = var2 + (((int64_t)dig_P4) << 35);
  var1 = ((var1 * var1 * (int64_t)dig_P3) >> 8) + ((var1 * (int64_t)dig_P2) << 12);
  var1 = (((((int64_t)1) << 47) + var1)) * ((int64_t)dig_P1) >> 33;
  if (var1 == 0) return 0;
  p = 1048576 - adc_P;
  p = (((p << 31) - var2) * 3125) / var1;
  var1 = (((int64_t)dig_P9) * (p >> 13) * (p >> 13)) >> 25;
  var2 = (((int64_t)dig_P8) * p) >> 19;
  p = ((p + var1 + var2) >> 8) + (((int64_t)dig_P7) << 4);
  return (uint32_t)p;
}

/* Humidity in %RH as Q22.10. */
static uint32_t bme_comp_H(int32_t adc_H) {
  int32_t v = (t_fine - ((int32_t)76800));
  v = (((((adc_H << 14) - (((int32_t)dig_H4) << 20) - (((int32_t)dig_H5) * v)) + ((int32_t)16384)) >> 15) *
       (((((((v * ((int32_t)dig_H6)) >> 10) * (((v * ((int32_t)dig_H3)) >> 11) + ((int32_t)32768))) >> 10) + ((int32_t)2097152)) *
             ((int32_t)dig_H2) +
         8192) >>
        14));
  v = (v - (((((v >> 15) * (v >> 15)) >> 7) * ((int32_t)dig_H1)) >> 4));
  v = (v < 0 ? 0 : v);
  v = (v > 419430400 ? 419430400 : v);
  return (uint32_t)(v >> 12);
}

/* ------------------------------------------------------------------ main */

int main(void) {
  DDRB |= _BV(PB5); /* status LED */
  DDRD |= _BV(PD6); /* PWM LED (OC0A) */

  /* Timer0: fast PWM on OC0A, non-inverting, clk/64 -> 976 Hz */
  TCCR0A = _BV(COM0A1) | _BV(WGM01) | _BV(WGM00);
  TCCR0B = _BV(CS01) | _BV(CS00);
  OCR0A = 0;

  uart_init();
  twi_init();
  timebase_init();
  sei();

  printf("\r\nenv-sensor 1.0 (ATmega328P @ 16 MHz, BME280 @ 0x76)\r\n");

  uint8_t id = 0;
  if (!bme_read(0xD0, &id, 1)) printf("BME280: no ACK at 0x76 (check wiring / pull-ups)\r\n");
  printf("BME280 id=0x%02X%s\r\n", id, id == 0x60 ? "" : " (unexpected)");

  bme_write(0xE0, 0xB6); /* soft reset */
  _delay_ms(3);          /* 2 ms start-up */
  uint8_t calibrated = bme_read_calibration();
  if (!calibrated) printf("BME280: calibration read failed\r\n");
  bme_write(0xF2, 0x01); /* ctrl_hum: osrs_h x1 (applies after ctrl_meas write) */
  bme_write(0xF5, 0x00); /* config: no IIR filter */

  uint32_t last = millis();
  uint8_t fade = 0;
  for (;;) {
    bme_write(0xF4, (1 << 5) | (1 << 2) | 0x01); /* osrs_t x1, osrs_p x1, forced mode */
    uint8_t status = 0x08;
    for (uint8_t guard = 0; guard < 50 && (status & 0x08); guard++) {
      _delay_ms(1);
      if (!bme_read(0xF3, &status, 1)) break;
    }
    uint8_t d[8];
    if (calibrated && bme_read(0xF7, d, 8)) {
      int32_t adc_P = ((int32_t)d[0] << 12) | ((int32_t)d[1] << 4) | (d[2] >> 4);
      int32_t adc_T = ((int32_t)d[3] << 12) | ((int32_t)d[4] << 4) | (d[5] >> 4);
      int32_t adc_H = ((int32_t)d[6] << 8) | d[7];
      int32_t t = bme_comp_T(adc_T);   /* 0.01 degC */
      uint32_t p = bme_comp_P(adc_P);  /* Pa Q24.8 */
      uint32_t h = bme_comp_H(adc_H);  /* %RH Q22.10 */
      uint32_t p_dhpa = ((p >> 8) + 5) / 10;       /* 0.1 hPa */
      uint32_t h_d = (h * 10 + 512) >> 10;         /* 0.1 %RH */
      int32_t ta = labs(t);
      printf("T=%s%ld.%02ldC P=%lu.%luhPa H=%lu.%lu%%\r\n", t < 0 ? "-" : "", ta / 100, ta % 100, p_dhpa / 10, p_dhpa % 10,
             h_d / 10, h_d % 10);
    } else {
      printf("BME280: read error\r\n");
    }

    PORTB ^= _BV(PB5);                          /* status LED */
    fade += 32;                                  /* breathing LED: triangle 0..255..0 */
    OCR0A = (fade & 0x80) ? (uint8_t)(255 - ((fade & 0x7F) << 1)) : (uint8_t)((fade & 0x7F) << 1);

    while ((uint32_t)(millis() - last) < PERIOD_MS) {
    }
    last += PERIOD_MS;
  }
}
