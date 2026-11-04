# env-sensor firmware for ATmega328P @ 16 MHz (avr-gcc + avr-libc)
MCU     ?= atmega328p
F_CPU   ?= 16000000UL
CC      = avr-gcc
OBJCOPY = avr-objcopy
SIZE    = avr-size

CFLAGS  = -mmcu=$(MCU) -DF_CPU=$(F_CPU) -Os -std=gnu11 -Wall -Wextra \
          -ffunction-sections -fdata-sections
LDFLAGS = -mmcu=$(MCU) -Wl,--gc-sections

TARGET = env-sensor

all: $(TARGET).hex

$(TARGET).elf: main.c
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ $<
	$(SIZE) $@

$(TARGET).hex: $(TARGET).elf
	$(OBJCOPY) -O ihex -R .eeprom $< $@

clean:
	rm -f $(TARGET).elf

.PHONY: all clean
