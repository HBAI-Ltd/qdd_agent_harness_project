#pragma once
#include "FreeRTOS.h"
typedef void *TaskHandle_t;
int xTaskCreate(void (*entry)(void *), const char *name, unsigned stack,
    void *context, unsigned priority, TaskHandle_t *handle);
void vTaskDelay(unsigned ticks);
