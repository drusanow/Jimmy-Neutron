/* Host-side stand-in for the STM32F072 device header, used only by tests/.
 * Peripheral registers become plain variables the tests can inspect. */
#ifndef HOST_STM32F072XB_SHIM_H
#define HOST_STM32F072XB_SHIM_H

#include <stdint.h>

#define __IO volatile

typedef struct { __IO uint32_t MODER, BSRR, IDR, ODR; } GPIO_TypeDef;
typedef struct { __IO uint32_t DHR12L1, DHR12L2, CR; } DAC_TypeDef;
typedef struct { __IO uint32_t CNT; } TIM_TypeDef;

extern GPIO_TypeDef host_gpioa, host_gpiob, host_gpioc;
extern DAC_TypeDef host_dac;
extern TIM_TypeDef host_tim2;

#define GPIOA (&host_gpioa)
#define GPIOB (&host_gpiob)
#define GPIOC (&host_gpioc)
#define DAC1  (&host_dac)
#define TIM2  (&host_tim2)

typedef enum { EXTI2_3_IRQn = 6, TIM6_DAC_IRQn = 17, TIM7_IRQn = 18 } IRQn_Type;
static inline void NVIC_EnableIRQ(IRQn_Type n) { (void)n; }
static inline void NVIC_DisableIRQ(IRQn_Type n) { (void)n; }

#define __aligned(x) __attribute__((aligned(x)))

#endif
