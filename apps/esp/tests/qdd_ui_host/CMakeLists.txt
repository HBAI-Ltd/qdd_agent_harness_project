cmake_minimum_required(VERSION 3.16)
project(qdd_ui_host C)
get_filename_component(QDD_ROOT "../.." ABSOLUTE)
set(CONFIG_LV_BUILD_DEMOS OFF CACHE BOOL "" FORCE)
set(CONFIG_LV_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(CONFIG_LV_USE_THORVG_INTERNAL OFF CACHE BOOL "" FORCE)
set(LV_BUILD_CONF_PATH "${CMAKE_CURRENT_SOURCE_DIR}/lv_conf.h" CACHE PATH "" FORCE)
add_subdirectory("${QDD_ROOT}/managed_components/lvgl__lvgl" lvgl)
add_executable(qdd_ui_host render.c "${QDD_ROOT}/main/qdd_ui.c"
    "${QDD_ROOT}/main/qdd_ui_model.c"
    "${QDD_ROOT}/main/qdd_setup_model.c" "${QDD_ROOT}/main/qdd_net_config.c"
    "${QDD_ROOT}/assets/fonts/qdd_cjk_14.c" "${QDD_ROOT}/assets/fonts/qdd_cjk_20.c"
    "${QDD_ROOT}/components/bsp/src/bsp_display_rounding.c")
target_include_directories(qdd_ui_host PRIVATE stubs "${QDD_ROOT}/main" "${QDD_ROOT}/components/bsp/src")
target_link_libraries(qdd_ui_host PRIVATE lvgl)
if(CMAKE_C_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(qdd_ui_host PRIVATE -Wall -Wextra -Werror)
endif()
