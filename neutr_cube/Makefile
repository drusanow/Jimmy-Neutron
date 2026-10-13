# Portable command-line build for neutr_cube.
# Same sources and compiler flags as the Eclipse (SW4STM32) Debug configuration.
#
#   make            -> build/neutr_cube.elf, .hex, .bin and .dfu
#   make clean
#
# Requires arm-none-eabi-gcc (e.g. apt install gcc-arm-none-eabi) and python3 (for the .dfu file).

TARGET   = neutr_cube
BUILD    = build

PREFIX  ?= arm-none-eabi-
CC       = $(PREFIX)gcc
OBJCOPY  = $(PREFIX)objcopy
SIZE     = $(PREFIX)size
PYTHON  ?= python3

HAL_SRC  = Drivers/STM32F0xx_HAL_Driver/Src
C_SRCS   = $(wildcard neutr_src/*.c) $(wildcard Core/Src/*.c) \
           $(HAL_SRC)/stm32f0xx_hal.c \
           $(HAL_SRC)/stm32f0xx_hal_adc.c \
           $(HAL_SRC)/stm32f0xx_hal_adc_ex.c \
           $(HAL_SRC)/stm32f0xx_hal_cortex.c \
           $(HAL_SRC)/stm32f0xx_hal_dac.c \
           $(HAL_SRC)/stm32f0xx_hal_dac_ex.c \
           $(HAL_SRC)/stm32f0xx_hal_dma.c \
           $(HAL_SRC)/stm32f0xx_hal_flash.c \
           $(HAL_SRC)/stm32f0xx_hal_flash_ex.c \
           $(HAL_SRC)/stm32f0xx_hal_gpio.c \
           $(HAL_SRC)/stm32f0xx_hal_i2c.c \
           $(HAL_SRC)/stm32f0xx_hal_i2c_ex.c \
           $(HAL_SRC)/stm32f0xx_hal_pcd.c \
           $(HAL_SRC)/stm32f0xx_hal_pcd_ex.c \
           $(HAL_SRC)/stm32f0xx_hal_pwr.c \
           $(HAL_SRC)/stm32f0xx_hal_pwr_ex.c \
           $(HAL_SRC)/stm32f0xx_hal_rcc.c \
           $(HAL_SRC)/stm32f0xx_hal_rcc_ex.c \
           $(HAL_SRC)/stm32f0xx_hal_spi.c \
           $(HAL_SRC)/stm32f0xx_hal_spi_ex.c \
           $(HAL_SRC)/stm32f0xx_hal_tim.c \
           $(HAL_SRC)/stm32f0xx_hal_tim_ex.c \
           $(HAL_SRC)/stm32f0xx_hal_uart.c \
           $(HAL_SRC)/stm32f0xx_hal_uart_ex.c
S_SRCS   = startup/startup_stm32f072xb.s

INCLUDES = -ICore/Inc \
           -IDrivers/STM32F0xx_HAL_Driver/Inc \
           -IDrivers/STM32F0xx_HAL_Driver/Inc/Legacy \
           -IDrivers/CMSIS/Device/ST/STM32F0xx/Include \
           -IDrivers/CMSIS/Include \
           -Ineutr_src

MCU      = -mcpu=cortex-m0 -mthumb -mfloat-abi=soft
DEFS     = '-D__weak=__attribute__((weak))' '-D__packed=__attribute__((__packed__))' \
           -DUSE_HAL_DRIVER -DSTM32F072xB
CFLAGS   = $(MCU) $(DEFS) $(INCLUDES) -O3 -Wall -Wextra -fmessage-length=0 -ffunction-sections -MMD -MP
LDSCRIPT = STM32F072CBTx_FLASH.ld
LDFLAGS  = $(MCU) -specs=nosys.specs -specs=nano.specs -T$(LDSCRIPT) \
           -Wl,-Map=$(BUILD)/$(TARGET).map -Wl,--gc-sections

OBJS     = $(addprefix $(BUILD)/,$(C_SRCS:.c=.o) $(S_SRCS:.s=.o))

all: $(BUILD)/$(TARGET).elf $(BUILD)/$(TARGET).hex $(BUILD)/$(TARGET).bin $(BUILD)/$(TARGET).dfu
	$(SIZE) $(BUILD)/$(TARGET).elf

$(BUILD)/%.o: %.c
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -c $< -o $@

$(BUILD)/%.o: %.s
	@mkdir -p $(dir $@)
	$(CC) $(MCU) -c $< -o $@

$(BUILD)/$(TARGET).elf: $(OBJS) $(LDSCRIPT)
	$(CC) $(LDFLAGS) -o $@ $(OBJS) -lm

$(BUILD)/$(TARGET).hex: $(BUILD)/$(TARGET).elf
	$(OBJCOPY) -O ihex $< $@

$(BUILD)/$(TARGET).bin: $(BUILD)/$(TARGET).elf
	$(OBJCOPY) -O binary $< $@

$(BUILD)/$(TARGET).dfu: $(BUILD)/$(TARGET).bin tools/bin2dfu.py
	$(PYTHON) tools/bin2dfu.py $< $@

clean:
	rm -rf $(BUILD)

.PHONY: all clean

-include $(OBJS:.o=.d)

# Host-side tests of the DSP code (gcc for the build machine, fake hardware header in tests/shim)
HOSTCC     ?= gcc
TEST_FLAGS  = -std=gnu11 -O2 -Wall -Wno-unused-function -DHOST_TEST -DSTM32F072xB -Itests/shim -Ineutr_src

$(BUILD)/test/test_osc_shape: tests/test_osc_shape.c neutr_src/osc_shape.c neutr_src/tables.c
	@mkdir -p $(dir $@)
	$(HOSTCC) $(TEST_FLAGS) -o $@ $^

$(BUILD)/test/test_lfo_osc_pitch: tests/test_lfo_osc_pitch.c neutr_src/lfo_osc_pitch.c
	@mkdir -p $(dir $@)
	$(HOSTCC) $(TEST_FLAGS) -o $@ $^

$(BUILD)/test/test_wavetable: tests/test_wavetable.c neutr_src/neutr_lfo_6wavetable.c neutr_src/wavetables.c \
                              neutr_src/lfo_osc_pitch.c neutr_src/tables.c
	@mkdir -p $(dir $@)
	$(HOSTCC) $(TEST_FLAGS) -o $@ $^

test: $(BUILD)/test/test_osc_shape $(BUILD)/test/test_lfo_osc_pitch $(BUILD)/test/test_wavetable
	$(BUILD)/test/test_osc_shape
	$(BUILD)/test/test_lfo_osc_pitch
	$(BUILD)/test/test_wavetable $(BUILD)/test/wavetable.raw
	$(PYTHON) tests/analyse_wavetable.py $(BUILD)/test/wavetable.raw

.PHONY: test
