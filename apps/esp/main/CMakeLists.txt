idf_component_register(
    SRCS "qdd_main.c" "qdd_hid.c" "qdd_ble.c" "qdd_ui.c" "qdd_ui_model.c"
         "qdd_control.c" "qdd_wifi.c" "qdd_net_config.c" "qdd_setup_model.c"
         "qdd_onboarding.c" "qdd_onboarding_model.c" "qdd_reset.c"
         "../assets/fonts/qdd_cjk_14.c" "../assets/fonts/qdd_cjk_20.c"
    INCLUDE_DIRS "."
    REQUIRES bsp bt esp_timer nvs_flash esp_driver_usb_serial_jtag esp_wifi esp_netif esp_event lwip esp_http_server
)

set(qdd_apk_source "${CMAKE_CURRENT_LIST_DIR}/../../android-screen/build/qdd-android-screen-debug.apk")
if(NOT EXISTS "${qdd_apk_source}")
    message(FATAL_ERROR "Build the phone App first: npm run build:android:screen from the repository root. The ESP onboarding page embeds its signed APK.")
endif()
file(SHA256 "${qdd_apk_source}" qdd_apk_hash)
file(SIZE "${qdd_apk_source}" qdd_apk_size)
set(qdd_apk_manifest "${CMAKE_CURRENT_LIST_DIR}/../../android-screen/build/manifest.json")
if(NOT EXISTS "${qdd_apk_manifest}")
    message(FATAL_ERROR "The phone APK manifest is missing. Run npm run build:android:screen before building the ESP firmware.")
endif()
file(READ "${qdd_apk_manifest}" qdd_apk_manifest_json)
string(JSON qdd_apk_manifest_hash ERROR_VARIABLE qdd_apk_manifest_error GET "${qdd_apk_manifest_json}" sha256)
if(qdd_apk_manifest_error OR NOT qdd_apk_manifest_hash STREQUAL qdd_apk_hash)
    message(FATAL_ERROR "The phone APK does not match build/manifest.json. Rebuild the phone App before embedding it in ESP firmware.")
endif()
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${qdd_apk_manifest}")
if(qdd_apk_size LESS 1 OR qdd_apk_size GREATER 1048576)
    message(FATAL_ERROR "The phone onboarding APK must be nonempty and at most 1 MiB.")
endif()
configure_file("${qdd_apk_source}" "${CMAKE_CURRENT_BINARY_DIR}/qdd_remote.apk" COPYONLY)
file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/qdd_onboarding_apk.h"
    "#pragma once\n#define QDD_ONBOARDING_APK_SHA256 \"${qdd_apk_hash}\"\n#define QDD_ONBOARDING_APK_SIZE ${qdd_apk_size}u\n")
target_include_directories(${COMPONENT_LIB} PRIVATE "${CMAKE_CURRENT_BINARY_DIR}")
target_add_binary_data(${COMPONENT_LIB} "${CMAKE_CURRENT_BINARY_DIR}/qdd_remote.apk" BINARY RENAME_TO qdd_remote_apk)
