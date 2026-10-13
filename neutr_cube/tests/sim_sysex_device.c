/* Simulated Neutron for testing the editor protocol end to end.
 * Builds the real neutr_src/usb_midi.c and neutr_src/sysex.c on the host.
 *
 * stdin:  one message per line, hex bytes (what the app would send over USB MIDI)
 * stdout: one line per reply sysex (hex), plus "# ..." lines for side effects
 *         (autotune, save, defaults, bootloader). An empty line ends each request.
 */
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include "tusb.h"
#include "neutron.h"
#include "menu.h"
#include "neutr_lfo_common.h"

GPIO_TypeDef host_gpioa, host_gpiob, host_gpioc;
DAC_TypeDef host_dac;
TIM_TypeDef host_tim2;
NVIC_Type host_nvic;
uint32_t host_uid[3] = {1, 2, 3};

volatile parameters_t parameters;
volatile uint8_t midi_channel_switch = 0;
volatile uint16_t pp_modwheel;
volatile uint8_t pp_aftertouch;
volatile lforam_t lforam;

/* synth side */
void noteon(note_t n) { printf("# noteon %d %d\n", n.note, n.velo); }
void noteoff(note_t n) { printf("# noteoff %d\n", n.note); }
void damper(uint8_t v) { (void)v; }
void va_panic(void) {}
void pp_pitchwheel(int16_t v) { (void)v; }
void midiclock(void) {}
void midistart(void) {}
void msp_root(void) { printf("# root\n"); }
void va_setmode(uint8_t m) { printf("# paramode %d\n", m); }
uint8_t save_parameters(void) { printf("# save\n"); return 0; }
void ft_delay(uint32_t ms) { (void)ms; }
void bootloader_request(void) { printf("# bootloader\n"); }
void ft_o1tune(void) { printf("# autotune 1\n"); parameters.o1tunecf = 0x8A11; parameters.o1tuneoctcf = 0xA411; parameters.o1tuneoff = 0x5111; }
void ft_o2tune(void) { printf("# autotune 2\n"); parameters.o2tunecf = 0x8A22; parameters.o2tuneoctcf = 0xA422; parameters.o2tuneoff = 0x5122; }
void nvm_initialize(void)
{
	printf("# defaults\n");
	memset((void*)&parameters, 0, sizeof parameters);
	parameters.o1tunecf = 0x8A00; parameters.o1tuneoctcf = 0xA400; parameters.o1tuneoff = 0x5100;
	parameters.o2tunecf = 0x8A00; parameters.o2tuneoctcf = 0xA400; parameters.o2tuneoff = 0x5100;
	parameters.o1oct = 1; parameters.o2oct = 1; parameters.o1pwrange = 2; parameters.o2pwrange = 2;
	parameters.o1widerange = 1; parameters.o2widerange = 1;
	parameters.flttunecf = 0x8500; parameters.astunecf = 0x8500; parameters.astuneoff = 0x0200; parameters.asmode = 2;
	parameters.shpdrift_rate = 0x600;
}

/* USB: requests are split into USB MIDI packets like a host driver would */
static uint8_t rx_q[64][4]; static int rx_n, rx_r;
bool tud_midi_n_packet_read(uint8_t itf, uint8_t p[4]) { (void)itf; if (rx_r == rx_n) return false; memcpy(p, rx_q[rx_r++], 4); return true; }
bool tud_midi_n_packet_write(uint8_t itf, uint8_t const p[4]) { (void)itf; (void)p; return true; }
bool tud_midi_n_mounted(uint8_t itf) { (void)itf; return true; }
bool tud_init(uint8_t rhport) { (void)rhport; return true; }
void tud_task_ext(uint32_t t, bool i) { (void)t; (void)i; }
void dcd_int_handler(uint8_t rhport) { (void)rhport; }
bool tud_inited(void) { return true; }

static uint8_t out[1024]; static int out_n;
uint32_t tud_midi_n_stream_write(uint8_t itf, uint8_t cable, uint8_t const* b, uint32_t n)
{
	(void)itf; (void)cable;
	for (uint32_t i = 0; i < n; i++) {
		out[out_n++] = b[i];
		if (b[i] == 0xF7) {
			for (int k = 0; k < out_n; k++) printf("%02X%s", out[k], k + 1 < out_n ? " " : "\n");
			out_n = 0;
		}
	}
	return n;
}

void usbmidi_task(void);

static void queue_message(const uint8_t* m, int n)
{
	rx_n = rx_r = 0;
	if (m[0] == 0xF0) {
		int i = 0;
		while (i < n) {
			int left = n - i;
			uint8_t p[4] = {0, 0, 0, 0};
			if (left > 3 || (left == 3 && m[i + 2] != 0xF7)) { p[0] = 0x04; memcpy(p + 1, m + i, 3); i += 3; }
			else { p[0] = (uint8_t)(0x04 + left); memcpy(p + 1, m + i, left); i += left; }
			memcpy(rx_q[rx_n++], p, 4);
		}
	} else {
		uint8_t p[4] = {(uint8_t)(m[0] >> 4), m[0], n > 1 ? m[1] : 0, n > 2 ? m[2] : 0};
		memcpy(rx_q[rx_n++], p, 4);
	}
}

int main(void)
{
	setvbuf(stdout, NULL, _IOLBF, 0); //must come before the first output
	nvm_initialize();
	char line[2048];
	while (fgets(line, sizeof line, stdin)) {
		uint8_t m[512]; int n = 0;
		for (char* t = strtok(line, " \r\n"); t && n < 512; t = strtok(NULL, " \r\n"))
			m[n++] = (uint8_t)strtol(t, NULL, 16);
		if (n) {
			queue_message(m, n);
			usbmidi_task();
		}
		printf("\n");
	}
	return 0;
}
