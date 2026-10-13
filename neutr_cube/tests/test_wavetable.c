/* Host render of the wavetable lfo oscillator (neutr_src/neutr_lfo_6wavetable.c).
 * Writes raw 16-bit output for a set of notes and morph positions to the file given
 * as argument, analysed by tests/analyse_wavetable.py */
#include <stdio.h>
#include "neutron.h"
#include "menu.h"
#include "neutr_lfo_common.h"

GPIO_TypeDef host_gpioa, host_gpiob, host_gpioc;
DAC_TypeDef host_dac;
TIM_TypeDef host_tim2;

volatile parameters_t parameters;
volatile lforam_t lforam;
volatile uint16_t lforate, lfoshape;
volatile uint32_t pp_o1p, pp_o2p;
volatile int32_t pp_o1pwshift, pp_o2pwshift;

void nl_init_classic(uint8_t prevmode) { (void)prevmode; lforam.irqstate = 0; }
void nlex_leds(uint32_t frame) { (void)frame; }
void nlwt_sr(void);
void nlwt_cr(void);
void nlwt_init(uint8_t prevmode);

#define SR 48000
#define SECONDS 1

int main(int argc, char **argv)
{
	if (argc != 2) return 2;
	FILE *f = fopen(argv[1], "wb");
	const int notes[] = {24, 36, 48, 60, 72, 84, 96, 108};
	const int shapes[] = {0, 0x249, 0x492, 0x6DB, 0x924, 0xB6D, 0xDB6, 0xFFF, 0x6C0};
	lforate = 0x800;                           /* +0 semitones in free mode */
	for (unsigned n = 0; n < sizeof notes / sizeof *notes; n++)
		for (unsigned s = 0; s < sizeof shapes / sizeof *shapes; s++) {
			nlwt_init(0);
			pp_o2p = (uint32_t)notes[n] << 24;
			lfoshape = shapes[s];
			for (int i = 0; i < 200; i++) nlwt_cr();   /* settle morph smoothing */
			for (int i = 0; i < SR * SECONDS; i++) {
				if ((i % 16) == 0) nlwt_cr();          /* cr runs every 16.384 samples */
				nlwt_sr();
				uint16_t v = host_dac.DHR12L2;
				fwrite(&v, 2, 1, f);
			}
		}
	fclose(f);
	return 0;
}
