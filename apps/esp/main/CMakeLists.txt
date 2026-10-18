idf_component_register(
    SRCS "qdd_main.c" "qdd_hid.c" "qdd_text.c" "qdd_ble.c" "qdd_ui.c" "qdd_ui_model.c"
         "qdd_control.c" "qdd_wifi.c" "qdd_net_config.c" "qdd_setup_model.c"
         "qdd_onboarding.c" "qdd_onboarding_model.c" "qdd_download_assets.c" "qdd_alloc_trace.c" "qdd_reset.c"
         "qdd_driver_protocol.c" "qdd_driver_usb.c"
         "../assets/fonts/qdd_cjk_14.c" "../assets/fonts/qdd_cjk_20.c"
    INCLUDE_DIRS "."
    REQUIRES bsp bt esp_timer nvs_flash esp_driver_usb_serial_jtag esp_wifi esp_netif esp_event lwip esp_http_server esp_partition mbedtls
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

# Factory-only boards have no assets partition. Keep the exact verified ZIP in
# read-only application Flash; existing assets partitions remain authoritative.
set(qdd_desktop_dir "${CMAKE_CURRENT_LIST_DIR}/../../android-mcp-rust/build/windows/v61")
set(qdd_desktop_manifest "${qdd_desktop_dir}/manifest.json")
set(qdd_desktop_archive "${qdd_desktop_dir}/设备操作台.zip")
set(qdd_desktop_prepare "${CMAKE_CURRENT_LIST_DIR}/../tools/prepare_desktop_zip.py")
if(NOT EXISTS "${qdd_desktop_manifest}" OR NOT EXISTS "${qdd_desktop_archive}")
    message(FATAL_ERROR "The verified v61 Windows ZIP and manifest are required for boards without an assets partition.")
endif()
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
    "${qdd_desktop_manifest}" "${qdd_desktop_archive}" "${qdd_desktop_prepare}"
    "${CMAKE_CURRENT_LIST_DIR}/../tools/pack_download_assets.py"
    "${CMAKE_CURRENT_LIST_DIR}/../tools/verify_firmware.py")
execute_process(COMMAND "${PYTHON}" "${qdd_desktop_prepare}" "${qdd_desktop_manifest}" "${qdd_desktop_archive}"
    "${CMAKE_CURRENT_BINARY_DIR}/qdd_desktop.zip" "${CMAKE_CURRENT_BINARY_DIR}/qdd_desktop_zip.h"
    RESULT_VARIABLE qdd_desktop_prepare_result OUTPUT_VARIABLE qdd_desktop_identity)
if(NOT qdd_desktop_prepare_result EQUAL 0)
    message(FATAL_ERROR "Verifying the embedded Windows ZIP failed.")
endif()
message(STATUS "Embedded Windows ZIP: ${qdd_desktop_identity}")
target_add_binary_data(${COMPONENT_LIB} "${CMAKE_CURRENT_BINARY_DIR}/qdd_desktop.zip" BINARY RENAME_TO qdd_desktop_zip)

set(qdd_driver_script "${CMAKE_CURRENT_LIST_DIR}/../assets/driver-download.js")
set(qdd_driver_prepare "${CMAKE_CURRENT_LIST_DIR}/../tools/prepare_driver_script.py")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${qdd_driver_script}" "${qdd_driver_prepare}")
execute_process(COMMAND "${PYTHON}" "${qdd_driver_prepare}" "${qdd_driver_script}"
    "${CMAKE_CURRENT_BINARY_DIR}/qdd_driver_download.js.gz"
    RESULT_VARIABLE qdd_driver_prepare_result OUTPUT_VARIABLE qdd_driver_script_identity)
if(NOT qdd_driver_prepare_result EQUAL 0)
    message(FATAL_ERROR "Preparing the bounded gzip download module failed.")
endif()
message(STATUS "Driver download module: ${qdd_driver_script_identity}")
target_add_binary_data(${COMPONENT_LIB} "${CMAKE_CURRENT_BINARY_DIR}/qdd_driver_download.js.gz" BINARY RENAME_TO qdd_driver_download_js)

set(qdd_usb_dir "${CMAKE_CURRENT_LIST_DIR}/../../android-mcp-rust/build/usb-driver/v52")
set(qdd_usb_manifest "${qdd_usb_dir}/manifest.json")
set(qdd_usb_executable "${qdd_usb_dir}/设备USB下载器.exe")
set(qdd_usb_prepare "${CMAKE_CURRENT_LIST_DIR}/../tools/prepare_usb_installer.py")
if(NOT EXISTS "${qdd_usb_manifest}" OR NOT EXISTS "${qdd_usb_executable}")
    message(FATAL_ERROR "Build the native USB downloader under apps/android-mcp-rust/tools/usb-driver before embedding it. Its v52 manifest and exact EXE are required.")
endif()
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
    "${qdd_usb_manifest}" "${qdd_usb_executable}" "${qdd_usb_prepare}")
execute_process(COMMAND "${PYTHON}" "${qdd_usb_prepare}" "${qdd_usb_manifest}" "${qdd_usb_executable}"
    "${CMAKE_CURRENT_BINARY_DIR}/qdd_usb_installer.exe.gz" "${CMAKE_CURRENT_BINARY_DIR}/qdd_usb_installer.h"
    RESULT_VARIABLE qdd_usb_prepare_result OUTPUT_VARIABLE qdd_usb_identity)
if(NOT qdd_usb_prepare_result EQUAL 0)
    message(FATAL_ERROR "Verifying and precompressing the native USB downloader failed.")
endif()
message(STATUS "USB downloader: ${qdd_usb_identity}")
target_add_binary_data(${COMPONENT_LIB} "${CMAKE_CURRENT_BINARY_DIR}/qdd_usb_installer.exe.gz" BINARY RENAME_TO qdd_usb_installer_exe)

set(qdd_receiver_dir "${CMAKE_CURRENT_LIST_DIR}/../../android-mcp-rust/build/usb-browser/v55")
set(qdd_receiver_manifest "${qdd_receiver_dir}/manifest.json")
set(qdd_receiver_html "${qdd_receiver_dir}/设备USB接收.html")
set(qdd_receiver_prepare "${CMAKE_CURRENT_LIST_DIR}/../tools/prepare_usb_receiver.py")
if(NOT EXISTS "${qdd_receiver_manifest}" OR NOT EXISTS "${qdd_receiver_html}")
    message(FATAL_ERROR "Build the self-contained offline USB receiver with apps/android-mcp-rust/tools/prepare-usb-receiver.mjs before embedding its v55 HTML.")
endif()
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
    "${qdd_receiver_manifest}" "${qdd_receiver_html}" "${qdd_receiver_prepare}"
    "${CMAKE_CURRENT_LIST_DIR}/../../android-mcp-rust/assets/usb-receiver/index.html"
    "${CMAKE_CURRENT_LIST_DIR}/../../android-mcp-rust/assets/usb-receiver/receiver.css"
    "${CMAKE_CURRENT_LIST_DIR}/../../android-mcp-rust/assets/usb-receiver/receiver.js"
    "${CMAKE_CURRENT_LIST_DIR}/../../android-mcp-rust/tools/prepare-usb-receiver.mjs"
    "${CMAKE_CURRENT_LIST_DIR}/../../android-mcp-rust/tools/test-usb-receiver.mjs")
execute_process(COMMAND "${PYTHON}" "${qdd_receiver_prepare}" "${qdd_receiver_manifest}" "${qdd_receiver_html}"
    "${CMAKE_CURRENT_BINARY_DIR}/qdd_usb_receiver.html.gz" "${CMAKE_CURRENT_BINARY_DIR}/qdd_usb_receiver.h"
    RESULT_VARIABLE qdd_receiver_prepare_result OUTPUT_VARIABLE qdd_receiver_identity)
if(NOT qdd_receiver_prepare_result EQUAL 0)
    message(FATAL_ERROR "Verifying and precompressing the self-contained offline USB receiver failed.")
endif()
message(STATUS "Offline USB receiver: ${qdd_receiver_identity}")
target_add_binary_data(${COMPONENT_LIB} "${CMAKE_CURRENT_BINARY_DIR}/qdd_usb_receiver.html.gz" BINARY RENAME_TO qdd_usb_receiver_html)

# Public GNU ld interception changes neither allocator arguments nor results.
# Wrap unresolved symbol references, including esp_adapter's allocator pointers.
target_link_libraries(${COMPONENT_LIB} INTERFACE
    "-Wl,--wrap=malloc" "-Wl,--wrap=calloc" "-Wl,--wrap=heap_caps_malloc")
