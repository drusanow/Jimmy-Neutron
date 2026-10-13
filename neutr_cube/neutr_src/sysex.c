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
 * sysex.c
 *
 * Editor protocol over USB MIDI SysEx (used by neutron-app).
 *
 *   request:  F0 7D 4E 43 <cmd> <payload> F7      (7D = non-commercial id, "NC" = neutr_cube)
 *   reply:    F0 7D 4E 43 <cmd|0x40> <payload> F7
 *
 *   values are 21 bit signed, 3 bytes, least significant 7 bits first
 *
 *   01 INFO                 -> protocol, fw version (ascii), midi channel, param count
 *   02 GET ALL              -> count, then (id, value) for every parameter
 *   03 SET    id value      -> id, value as stored after limits (or 7F if id is unknown)
 *   04 SAVE                 -> status (0 = ok)
 *   05 AUTOTUNE which       -> which (1 osc1, 2 osc2, 3 both), when finished
 *   06 DEFAULTS             -> 0 (parameters reset to defaults and saved, as PARAPH+OSC SYNC+KEYTRK)
 *   07 BOOTLOADER           -> 0, then the synth restarts into the USB DFU bootloader
 *
 * Commands are collected by the USB MIDI code and executed in the main loop.
 * Keep the ids stable, the app relies on them.
 */

#include "neutron.h"
#include "menu.h"

extern volatile uint8_t midi_channel_switch;

#define SX_ID0 0x7D
#define SX_ID1 0x4E
#define SX_ID2 0x43
#define SX_PROTOCOL 1
#define SX_FW_VERSION "1.6.0-cube"
#define SX_BUFSIZE 32

typedef enum
{
	PT_U8 = 0,
	PT_U16,
	PT_S16,
	PT_SYNCSTART, //uint32 stored <<20, exposed as 0..0xFFF
}ptype_en;

//what has to happen after a change
#define PF_ROOT  0x01 //msp_root() refreshes leds, gpio, octaves, lfo mode
#define PF_PARA  0x02 //paraphony mode switch

typedef struct
{
	volatile void* ptr;
	uint8_t type;
	uint8_t flags;
	int32_t min;
	int32_t max;
}sx_param_t;

#define P(field, type, flags, min, max) {&parameters.field, type, flags, min, max}

//index = parameter id
static const sx_param_t sx_params[] =
{
	P(o1tunecf,       PT_U16, 0,       TUNE_CF_MIN, TUNE_CF_MAX), // 0
	P(o1tuneoctcf,    PT_U16, 0,       TUNE_CF_MIN, TUNE_CF_MAX), // 1
	P(o1tuneoff,      PT_S16, 0,       -0x8000, 0x7FFF),          // 2
	P(o2tunecf,       PT_U16, 0,       TUNE_CF_MIN, TUNE_CF_MAX), // 3
	P(o2tuneoctcf,    PT_U16, 0,       TUNE_CF_MIN, TUNE_CF_MAX), // 4
	P(o2tuneoff,      PT_S16, 0,       -0x8000, 0x7FFF),          // 5
	P(o1oct,          PT_U8,  PF_ROOT, 0, 2),                     // 6
	P(o2oct,          PT_U8,  PF_ROOT, 0, 2),                     // 7
	P(o1pwrange,      PT_U8,  0,       0, 24),                    // 8
	P(o2pwrange,      PT_U8,  0,       0, 24),                    // 9
	P(o1widerange,    PT_U8,  PF_ROOT, 0, 1),                     // 10
	P(o2widerange,    PT_U8,  PF_ROOT, 0, 1),                     // 11
	P(o1moddis,       PT_U8,  PF_ROOT, 0, 1),                     // 12
	P(o2moddis,       PT_U8,  PF_ROOT, 0, 1),                     // 13
	P(o1glide,        PT_U16, 0,       0, 0xFFF),                 // 14
	P(o2glide,        PT_U16, 0,       0, 0xFFF),                 // 15
	P(osync,          PT_U8,  PF_ROOT, 0, 1),                     // 16
	P(paraphony,      PT_U8,  PF_PARA, 0, 2),                     // 17
	P(flttunecf,      PT_U16, 0,       TUNE_CF_MIN, TUNE_CF_MAX), // 18
	P(filtertype,     PT_U8,  PF_ROOT, 0, 2),                     // 19
	P(filterkeytrack, PT_U8,  PF_ROOT, 0, 1),                     // 20
	P(astunecf,       PT_U16, 0,       0, 0xFFFF),                // 21
	P(astuneoff,      PT_S16, 0,       -0x8000, 0x7FFF),          // 22
	P(asmode,         PT_U8,  0,       0, 4),                     // 23
	P(gateretrig,     PT_U8,  0,       0, 1),                     // 24
	P(lfokeysync,     PT_U8,  PF_ROOT, 0, 1),                     // 25
	P(lfoextsynctype, PT_U8,  0,       0, 2),                     // 26
	P(lfosyncstart,   PT_SYNCSTART, 0, 0, 0xFFF),                 // 27
	P(lfomidisync,    PT_U8,  0,       0, 1),                     // 28
	P(lfomode,        PT_U8,  PF_ROOT, 0, 6),                     // 29
	P(shpdrift_depth, PT_U16, 0,       0, 0xFFF),                 // 30
	P(shpdrift_rate,  PT_U16, 0,       0, 0xFFF),                 // 31
	P(lfooscsrc,      PT_U8,  0,       0, 1),                     // 32
	P(lfooscquant,    PT_U8,  0,       0, 1),                     // 33
};

#define SX_NPARAMS (sizeof(sx_params)/sizeof(sx_params[0]))

static uint8_t sx_buf[SX_BUFSIZE];
static uint8_t sx_len = 0;
static volatile uint8_t sx_ready = 0;
static uint8_t sx_overflow = 0;

//////////////////////////////////////////////////////////////////////////////

static int32_t sx_get(uint8_t id)
{
	const sx_param_t* p = &sx_params[id];
	switch (p->type)
	{
	case PT_U8:
		return *(volatile uint8_t*)p->ptr;
	case PT_U16:
		return *(volatile uint16_t*)p->ptr;
	case PT_S16:
		return *(volatile int16_t*)p->ptr;
	default:
		return (*(volatile uint32_t*)p->ptr) >> 20;
	}
}

static void sx_set(uint8_t id, int32_t v)
{
	const sx_param_t* p = &sx_params[id];
	if (v < p->min)
		v = p->min;
	if (v > p->max)
		v = p->max;
	switch (p->type)
	{
	case PT_U8:
		*(volatile uint8_t*)p->ptr = (uint8_t)v;
		break;
	case PT_U16:
		*(volatile uint16_t*)p->ptr = (uint16_t)v;
		break;
	case PT_S16:
		*(volatile int16_t*)p->ptr = (int16_t)v;
		break;
	default:
		*(volatile uint32_t*)p->ptr = (uint32_t)v << 20;
		break;
	}
	if (p->flags & PF_PARA)
	{
		//same as the PARAPHONIC button: paraphonic modes switch osc cv modulation off
		parameters.o1moddis = parameters.paraphony ? 1 : 0;
		parameters.o2moddis = parameters.paraphony ? 1 : 0;
		va_setmode(parameters.paraphony);
	}
	if (p->flags & (PF_ROOT | PF_PARA))
		msp_root();
}

static uint8_t* sx_put_value(uint8_t* d, int32_t v)
{
	d[0] = v & 0x7F;
	d[1] = (v >> 7) & 0x7F;
	d[2] = (v >> 14) & 0x7F;
	return d + 3;
}

static int32_t sx_read_value(const uint8_t* s)
{
	int32_t v = s[0] | (s[1] << 7) | (s[2] << 14);
	if (v & 0x100000) //sign extend 21 bit
		v -= 0x200000;
	return v;
}

static void sx_reply(uint8_t cmd, const uint8_t* payload, uint16_t len)
{
	uint8_t head[5] = {0xF0, SX_ID0, SX_ID1, SX_ID2, (uint8_t)(cmd | 0x40)};
	static const uint8_t tail = 0xF7;
	usbmidi_send(head, 5);
	usbmidi_send(payload, len);
	usbmidi_send(&tail, 1);
}

//////////////////////////////////////////////////////////////////////////////

//sysex bytes from USB, F0..F7. called with the midi interrupts masked - only buffering here
void sysex_rx(const uint8_t* b, uint8_t n)
{
	for (uint8_t i = 0; i < n; i++)
	{
		uint8_t c = b[i];
		if (c == 0xF0)
		{
			sx_len = 0;
			sx_overflow = 0;
		}
		if (sx_ready) //previous one not handled yet - drop
			continue;
		if (sx_len < SX_BUFSIZE)
			sx_buf[sx_len++] = c;
		else
			sx_overflow = 1;
		if (c == 0xF7)
		{
			if (!sx_overflow)
				sx_ready = 1;
			else
				sx_len = 0;
		}
	}
}

//main loop
void sysex_task(void)
{
	if (!sx_ready)
		return;
	uint8_t len = sx_len;
	const uint8_t* m = sx_buf;
	sx_ready = 0;
	sx_len = 0;

	if ((len < 6) || (m[0] != 0xF0) || (m[1] != SX_ID0) || (m[2] != SX_ID1) || (m[3] != SX_ID2) || (m[len - 1] != 0xF7))
		return;
	uint8_t cmd = m[4];
	const uint8_t* pl = m + 5;
	uint8_t plen = len - 6;

	switch (cmd)
	{
	case 0x01: //info
	{
		static const char ver[] = SX_FW_VERSION;
		uint8_t out[3 + sizeof(ver)];
		uint8_t n = 0;
		out[n++] = SX_PROTOCOL;
		out[n++] = midi_channel_switch & 0x0F;
		out[n++] = SX_NPARAMS;
		for (uint8_t i = 0; ver[i]; i++)
			out[n++] = ver[i];
		sx_reply(cmd, out, n);
		break;
	}
	case 0x02: //get all
	{
		uint8_t out[1 + SX_NPARAMS * 4];
		uint8_t* d = out;
		*d++ = SX_NPARAMS;
		for (uint8_t i = 0; i < SX_NPARAMS; i++)
		{
			*d++ = i;
			d = sx_put_value(d, sx_get(i));
		}
		sx_reply(cmd, out, d - out);
		break;
	}
	case 0x03: //set
	{
		uint8_t out[4] = {0x7F, 0, 0, 0};
		if ((plen == 4) && (pl[0] < SX_NPARAMS))
		{
			sx_set(pl[0], sx_read_value(pl + 1));
			out[0] = pl[0];
			sx_put_value(out + 1, sx_get(pl[0]));
		}
		sx_reply(cmd, out, 4);
		break;
	}
	case 0x04: //save
	{
		uint8_t st = save_parameters();
		sx_reply(cmd, &st, 1);
		break;
	}
	case 0x05: //autotune
	{
		uint8_t which = plen ? pl[0] & 0x03 : 3;
		if (which & 1)
			ft_o1tune();
		if (which & 2)
			ft_o2tune();
		msp_root();
		sx_reply(cmd, &which, 1);
		break;
	}
	case 0x06: //defaults
	{
		uint8_t z = 0;
		nvm_initialize();
		va_setmode(parameters.paraphony);
		msp_root();
		sx_reply(cmd, &z, 1);
		break;
	}
	case 0x07: //bootloader
	{
		uint8_t z = 0;
		sx_reply(cmd, &z, 1);
		ft_delay(100); //let the reply leave
		bootloader_request();
		break;
	}
	}
}
