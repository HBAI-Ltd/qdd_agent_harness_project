#pragma once

typedef int portMUX_TYPE;
#define portMUX_INITIALIZER_UNLOCKED 0
void qdd_test_enter_critical(portMUX_TYPE *lock);
void qdd_test_exit_critical(portMUX_TYPE *lock);
#define portENTER_CRITICAL(lock) qdd_test_enter_critical(lock)
#define portEXIT_CRITICAL(lock) qdd_test_exit_critical(lock)
