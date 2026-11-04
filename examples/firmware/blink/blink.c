/*
 * blink — ATmega328P @ 16 MHz, avr-libc. Toggles PB5 (Arduino "D13" LED) every 500 ms,
 * i.e. a 1 Hz blink with 50 % duty cycle.
 *
 * Build: make
 */
#include <avr/io.h>
#include <util/delay.h>

int main(void) {
  DDRB |= _BV(PB5);
  for (;;) {
    PORTB ^= _BV(PB5);
    _delay_ms(500);
  }
}
