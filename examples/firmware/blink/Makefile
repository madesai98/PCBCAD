# blink firmware for ATmega328P @ 16 MHz (avr-gcc + avr-libc)
MCU     ?= atmega328p
F_CPU   ?= 16000000UL
CC      = avr-gcc
OBJCOPY = avr-objcopy
SIZE    = avr-size

CFLAGS  = -mmcu=$(MCU) -DF_CPU=$(F_CPU) -Os -std=gnu11 -Wall -Wextra
LDFLAGS = -mmcu=$(MCU)

all: blink.hex

blink.elf: blink.c
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ $<
	$(SIZE) $@

blink.hex: blink.elf
	$(OBJCOPY) -O ihex -R .eeprom $< $@

clean:
	rm -f blink.elf

.PHONY: all clean
