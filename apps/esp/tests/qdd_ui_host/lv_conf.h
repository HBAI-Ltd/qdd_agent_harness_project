#ifndef LV_CONF_H
#define LV_CONF_H
#ifndef __ASSEMBLER__
void qdd_host_lv_assert(const char *file, int line);
#endif
#define LV_ASSERT_HANDLER qdd_host_lv_assert(__FILE__, __LINE__);
#define LV_COLOR_DEPTH 16
#define LV_USE_OS LV_OS_NONE
#define LV_MEM_SIZE (24 * 1024U)
#define LV_MEM_POOL_EXPAND_SIZE 0
#define LV_DEF_REFR_PERIOD 20
#define LV_USE_LOG 0
#define LV_USE_FONT_COMPRESSED 0
#define LV_USE_FONT_PLACEHOLDER 1
#define LV_FONT_MONTSERRAT_14 1
#define LV_USE_THORVG 0
#define LV_USE_QRCODE 1
#endif
