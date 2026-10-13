/* Host test for neutr_src/usb_midi.c (real TinyUSB headers, USB transfers stubbed)
 *  - configuration descriptor is a well formed USB MIDI 1.0 descriptor
 *  - USB -> synth: every handled message, channel filter, realtime
 *  - DIN -> USB: running status, realtime inside a message, sysex skipped
 *  - interrupts masked during dispatch are restored
 */
#include <stdio.h>
#include <string.h>
#include "tusb.h"
#include "neutron.h"
#include "menu.h"
#include "neutr_lfo_common.h"

GPIO_TypeDef host_gpioa, host_gpiob, host_gpioc;
DAC_TypeDef host_dac;
TIM_TypeDef host_tim2;
NVIC_Type host_nvic;
uint32_t host_uid[3] = {0x12345678, 0x9ABCDEF0, 0x0F0F0F0F};

volatile uint8_t midi_channel_switch = 2;
volatile uint16_t pp_modwheel;
volatile uint8_t pp_aftertouch;
volatile lforam_t lforam;

static int failures;
#define CHECK(cond, ...) do { if (!(cond)) { failures++; printf("FAIL: " __VA_ARGS__); printf("\n"); } } while (0)

/* synth side stubs, record what was called */
static char log_buf[512];
static void logf_(const char* s) { strncat(log_buf, s, sizeof log_buf - strlen(log_buf) - 1); }
static char tmp[64];
static uint32_t masked_during_call;
#define REC(...) do { snprintf(tmp, sizeof tmp, __VA_ARGS__); logf_(tmp); masked_during_call |= host_nvic.ICER[0]; } while (0)
void noteon(note_t n) { REC("on%d/%d ", n.note, n.velo); }
void noteoff(note_t n) { REC("off%d ", n.note); }
void damper(uint8_t v) { REC("damp%d ", v); }
void va_panic(void) { REC("panic "); }
void pp_pitchwheel(int16_t v) { REC("pw%d ", v); }
void midiclock(void) { REC("clk "); }
void midistart(void) { REC("start "); }

/* TinyUSB stubs */
static uint8_t rx_q[16][4]; static int rx_n, rx_r;
static uint8_t tx_q[32][4]; static int tx_n;
bool tud_midi_n_packet_read(uint8_t itf, uint8_t p[4]) { (void)itf; if (rx_r == rx_n) return false; memcpy(p, rx_q[rx_r++], 4); return true; }
bool tud_midi_n_packet_write(uint8_t itf, uint8_t const p[4]) { (void)itf; memcpy(tx_q[tx_n++], p, 4); return true; }
bool tud_midi_n_mounted(uint8_t itf) { (void)itf; return true; }
bool tud_init(uint8_t rhport) { (void)rhport; return true; }
void tud_task_ext(uint32_t t, bool i) { (void)t; (void)i; }
void dcd_int_handler(uint8_t rhport) { (void)rhport; }
bool tud_inited(void) { return true; }
uint32_t tud_midi_n_stream_write(uint8_t itf, uint8_t cable, uint8_t const* b, uint32_t n) { (void)itf; (void)cable; (void)b; return n; }
/* editor sysex is tested end to end with sim_sysex_device and neutron-app/tests */
static int sysex_bytes;
void sysex_rx(const uint8_t* b, uint8_t n) { (void)b; sysex_bytes += n; }
void sysex_task(void) {}

void usbmidi_task(void);
void usbmidi_din_byte(uint8_t b);
uint8_t const * tud_descriptor_configuration_cb(uint8_t index);
uint8_t const * tud_descriptor_device_cb(void);
uint16_t const* tud_descriptor_string_cb(uint8_t index, uint16_t langid);

static void usb_in(uint8_t a, uint8_t b, uint8_t c, uint8_t d)
{
	rx_q[rx_n][0] = a; rx_q[rx_n][1] = b; rx_q[rx_n][2] = c; rx_q[rx_n][3] = d; rx_n++;
}

int main(void)
{
	/* descriptors */
	const uint8_t* cfg = tud_descriptor_configuration_cb(0);
	int total = cfg[2] | (cfg[3] << 8), pos = 0, itfs = 0, eps = 0, jacks = 0, ms_header = 0;
	while (pos < total) {
		int len = cfg[pos], type = cfg[pos + 1];
		CHECK(len >= 2, "descriptor length %d at %d", len, pos);
		if (len < 2) break;
		if (type == 4) itfs++;
		if (type == 5) eps++;
		if (type == 0x24 && cfg[pos + 2] == 0x01 && pos > 9) ms_header++;
		if (type == 0x24 && (cfg[pos + 2] == 0x02 || cfg[pos + 2] == 0x03)) jacks++;
		pos += len;
	}
	CHECK(pos == total, "descriptor walk ended at %d of %d", pos, total);
	CHECK(itfs == 2 && eps == 2 && jacks == 4, "itfs %d eps %d jacks %d", itfs, eps, jacks);
	const uint8_t* dev = tud_descriptor_device_cb();
	CHECK(dev[0] == 18 && dev[1] == 1, "device descriptor");
	const uint16_t* sd = tud_descriptor_string_cb(2, 0x409);
	CHECK((sd[0] >> 8) == 3 && (sd[0] & 0xFF) == 2 + 2 * 18, "product string header %04x", sd[0]);
	sd = tud_descriptor_string_cb(3, 0x409);
	CHECK((sd[0] & 0xFF) == 18 && sd[1] == '8' , "serial string");
	CHECK(tud_descriptor_string_cb(9, 0x409) == 0, "unknown string index");
	printf("config descriptor: %d bytes, %d interfaces, %d endpoints, %d jacks\n", total, itfs, eps, jacks);

	/* USB -> synth, channel 3 (index 2) */
	host_nvic.ISER[0] = (1u << USART1_IRQn) | (1u << TIM7_IRQn) | (1u << 17);
	usb_in(0x09, 0x92, 60, 100);   /* note on */
	usb_in(0x09, 0x92, 60, 0);     /* note on vel 0 = off */
	usb_in(0x08, 0x82, 62, 40);    /* note off */
	usb_in(0x09, 0x93, 64, 100);   /* other channel - ignored */
	usb_in(0x0E, 0xE2, 0, 0x40);   /* pitch wheel centre */
	usb_in(0x0E, 0xE2, 0x7F, 0x7F);/* pitch wheel max */
	usb_in(0x0B, 0xB2, 64, 127);   /* sustain */
	usb_in(0x0B, 0xB2, 123, 0);    /* all notes off */
	usb_in(0x0B, 0xB2, 1, 0x40);   /* mod wheel msb */
	usb_in(0x0D, 0xD2, 77, 0);     /* channel pressure */
	usb_in(0x0F, 0xF8, 0, 0);      /* clock */
	usb_in(0x0F, 0xFA, 0, 0);      /* start */
	usb_in(0x04, 0xF0, 0x7E, 0x00);/* sysex - ignored */
	usbmidi_task();
	const char* expect = "on60/100 off60 off62 pw0 pw8191 damp127 panic clk start ";
	CHECK(strcmp(log_buf, expect) == 0, "usb->synth got '%s'", log_buf);
	CHECK(pp_modwheel == (0x40 << 7), "mod wheel %x", pp_modwheel);
	CHECK(pp_aftertouch == 77, "aftertouch %d", pp_aftertouch);
	CHECK(sysex_bytes == 3, "sysex bytes passed on: %d", sysex_bytes);
	CHECK(masked_during_call == ((1u << USART1_IRQn) | (1u << TIM7_IRQn)), "masked irqs %x", masked_during_call);
	CHECK(host_nvic.ISER[0] == ((1u << USART1_IRQn) | (1u << TIM7_IRQn)), "irqs not restored");
	printf("usb->synth: %s\n", log_buf);

	/* DIN -> USB */
	const uint8_t din[] = {
		0x90, 60, 100, 62, 90,        /* note on + running status */
		0x80, 61, 0xF8, 0,            /* clock inside a message */
		0xF0, 0x7E, 1, 2, 0xF7,       /* sysex - skipped */
		0xC1, 5,                      /* program change */
		0xFE,                         /* active sensing - skipped */
		0xE0, 0, 0x40,                /* pitch wheel */
		33,                           /* dangling data byte, waits for running status */
	};
	for (unsigned i = 0; i < sizeof din; i++) usbmidi_din_byte(din[i]);
	usbmidi_task();
	const uint8_t want[][4] = {
		{0x09, 0x90, 60, 100}, {0x09, 0x90, 62, 90}, {0x0F, 0xF8, 0, 0}, {0x08, 0x80, 61, 0},
		{0x0C, 0xC1, 5, 0}, {0x0E, 0xE0, 0, 0x40},
	};
	CHECK(tx_n == 6, "din->usb packet count %d", tx_n);
	for (int i = 0; i < tx_n && i < 6; i++)
		CHECK(memcmp(tx_q[i], want[i], 4) == 0, "din->usb packet %d: %02x %02x %02x %02x", i, tx_q[i][0], tx_q[i][1], tx_q[i][2], tx_q[i][3]);
	printf("din->usb: %d packets\n", tx_n);

	printf(failures ? "usb_midi: %d FAILED\n" : "usb_midi: all passed\n", failures);
	return failures != 0;
}
