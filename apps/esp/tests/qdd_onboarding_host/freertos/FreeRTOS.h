#pragma once
#include <stddef.h>
#include <stdint.h>
typedef int portMUX_TYPE;
#define portMUX_INITIALIZER_UNLOCKED 0
void qdd_test_enter_critical(portMUX_TYPE *lock);
void qdd_test_exit_critical(portMUX_TYPE *lock);
#define portENTER_CRITICAL(lock) qdd_test_enter_critical(lock)
#define portEXIT_CRITICAL(lock) qdd_test_exit_critical(lock)
#define pdPASS 1
#define tskIDLE_PRIORITY 0
#define pdMS_TO_TICKS(value) (value)
#define taskYIELD() qdd_test_yield()
void qdd_test_yield(void);
