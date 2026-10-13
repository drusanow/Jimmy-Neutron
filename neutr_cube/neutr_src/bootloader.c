/*

This file is part of neutr_cube project.

neutr_cube is free software: you can redistribute it and/or modify it under the
terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later
version.

neutr_cube is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR
A PARTICULAR PURPOSE. See the GNU General Public License for more details.

You should have received a copy of the GNU General Public License along with
neutr_cube. If not, see <http://www.gnu.org/licenses/>.
 *
 * bootloader.c
 *
 * Software entry to the STM32 ROM bootloader (USB DFU), so any firmware - including
 * the original Behringer one - can be flashed without the hardware BOOT button.
 *
 * Hold OSC SYNC + FILTER MODE while powering on. All leds light up, the synth resets,
 * and the first thing main() does is jump into system memory. The ROM bootloader
 * can not be erased, so this is always safe. Power cycle to leave it.
 *
 * The request survives the reset in two words at the top of RAM, above the stack
 * (_estack is moved down by 8 bytes in the linker script).
 */

#include "neutron.h"

#define BOOTREQ ((volatile uint32_t*)0x20003FF8)
#define BOOTREQ_KEY 0xB007D0F0u
//STM32F072 system memory (ROM bootloader)
#define SYSMEM_BASE 0x1FFFC800u

void bootloader_check(void)
{
	if ((BOOTREQ[0] != BOOTREQ_KEY) || (BOOTREQ[1] != ~BOOTREQ_KEY))
		return;
	BOOTREQ[0] = 0;
	BOOTREQ[1] = 0;

	//cortex-m0 has no vector table offset, map system memory to 0x00000000 instead
	RCC->APB2ENR |= RCC_APB2ENR_SYSCFGEN;
	SYSCFG->CFGR1 = (SYSCFG->CFGR1 & ~SYSCFG_CFGR1_MEM_MODE) | SYSCFG_CFGR1_MEM_MODE_0;

	uint32_t sp = *(volatile uint32_t*)SYSMEM_BASE;
	void (*rom_entry)(void) = (void (*)(void))(*(volatile uint32_t*)(SYSMEM_BASE + 4));
	__set_MSP(sp);
	rom_entry();
	while (1)
	{
		;
	}
}

void bootloader_request(void)
{
	BOOTREQ[0] = BOOTREQ_KEY;
	BOOTREQ[1] = ~BOOTREQ_KEY;
	NVIC_SystemReset();
}
