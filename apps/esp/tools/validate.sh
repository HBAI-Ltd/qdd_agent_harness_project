#!/usr/bin/env bash
set -euo pipefail

mode="${1:---all}"
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
windows_host=false
case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) windows_host=true ;;
esac
if "${windows_host}"; then
    # ESP-IDF's Windows virtual environment provides python.exe, not python3.exe.
    python_bin="${PYTHON:-python}"
else
    python_bin="${PYTHON:-python3}"
fi

usage() {
    echo "Usage: $0 [--all|--static|--firmware]" >&2
}

run_static_checks() {
    local actionlint_bin
    local test_dir
    local -a demo_compiler_flags=(-ffunction-sections -fdata-sections)

    if "${windows_host}"; then
        # MinGW's PE unwind records otherwise retain untested UI entry points.
        # Keep the same section GC boundary used by the Linux host tests.
        demo_compiler_flags+=(-fno-asynchronous-unwind-tables)
    fi

    "${python_bin}" tools/check_repo.py

    actionlint_bin="${ACTIONLINT_BIN:-}"
    if [[ -z "${actionlint_bin}" ]]; then
        actionlint_bin="$(command -v actionlint || true)"
    fi
    if [[ -z "${actionlint_bin}" || ! -x "${actionlint_bin}" ]]; then
        actionlint_bin="$(./tools/install-actionlint.sh)"
    fi
    "${actionlint_bin}" -color .github/workflows/*.yml

    test_dir="$(mktemp -d /tmp/ai-passport-host-tests.XXXXXX)"
    "${CC:-cc}" -std=c11 -Wall -Wextra -Werror -Imain \
        tests/test_qdd_hid.c main/qdd_hid.c \
        -o "${test_dir}/test_qdd_hid"
    "${test_dir}/test_qdd_hid"
    "${CC:-cc}" -std=c11 -Wall -Wextra -Werror -Imain \
        tests/test_qdd_text.c main/qdd_text.c -o "${test_dir}/test_qdd_text"
    "${test_dir}/test_qdd_text"
    "${CC:-cc}" -std=c11 -Wall -Wextra -Werror -Imain \
        tests/test_qdd_driver_protocol.c main/qdd_driver_protocol.c -o "${test_dir}/test_qdd_driver_protocol"
    "${test_dir}/test_qdd_driver_protocol"
    "${CC:-cc}" -std=c11 -Wall -Wextra -Werror -Itests/qdd_driver_host -Itests/qdd_onboarding_host -Imain \
        tests/test_qdd_driver_usb.c main/qdd_driver_protocol.c -o "${test_dir}/test_qdd_driver_usb"
    "${test_dir}/test_qdd_driver_usb"
    PYTHONDONTWRITEBYTECODE=1 "${python_bin}" tests/test_qdd_driver_usb_contract.py
    "${CC:-cc}" -std=c11 -Wall -Wextra -Werror -fno-builtin -Itests/qdd_alloc_host -Imain \
        tests/test_qdd_alloc_trace.c tests/test_qdd_alloc_trace_pointer.c \
        -Wl,--wrap=heap_caps_malloc -o "${test_dir}/test_qdd_alloc_trace"
    for alloc_case in success zero malloc calloc caps overflow; do
        "${test_dir}/test_qdd_alloc_trace" "${alloc_case}"
    done
    "${CC:-cc}" -std=c11 -Wall -Wextra -Werror -Imain \
        tests/test_qdd_ble_policy.c -o "${test_dir}/test_qdd_ble_policy"
    "${test_dir}/test_qdd_ble_policy"
    "${CC:-cc}" -std=c11 -Wall -Wextra -Werror -Imain \
        tests/test_qdd_ui_model.c main/qdd_ui_model.c main/qdd_hid.c \
        -o "${test_dir}/test_qdd_ui_model"
    "${test_dir}/test_qdd_ui_model"
    "${CC:-cc}" -std=c11 -Wall -Wextra -Werror -Imain \
        tests/test_qdd_control.c main/qdd_control.c -o "${test_dir}/test_qdd_control"
    "${test_dir}/test_qdd_control"
    "${CC:-cc}" -std=c11 -Wall -Wextra -Werror -Imain \
        tests/test_qdd_net_config.c main/qdd_net_config.c -o "${test_dir}/test_qdd_net_config"
    "${test_dir}/test_qdd_net_config"
    "${CC:-cc}" -std=c11 -Wall -Wextra -Werror -Imain \
        tests/test_qdd_setup_model.c main/qdd_setup_model.c main/qdd_net_config.c -o "${test_dir}/test_qdd_setup_model"
    "${test_dir}/test_qdd_setup_model"
    "${CC:-cc}" -std=c11 -Wall -Wextra -Werror -Imain \
        tests/test_qdd_onboarding_model.c main/qdd_onboarding_model.c -o "${test_dir}/test_qdd_onboarding_model"
    "${test_dir}/test_qdd_onboarding_model"
    "${CC:-cc}" -std=gnu11 -Wall -Wextra -Werror -Itests/qdd_onboarding_host -Imain \
        tests/test_qdd_onboarding.c main/qdd_onboarding_model.c -o "${test_dir}/test_qdd_onboarding"
    "${test_dir}/test_qdd_onboarding"
    "${NODE:-node}" --test tests/test_driver_download.mjs
    PYTHONDONTWRITEBYTECODE=1 "${python_bin}" tests/test_prepare_driver_script.py
    PYTHONDONTWRITEBYTECODE=1 "${python_bin}" tests/test_prepare_usb_installer.py
    PYTHONDONTWRITEBYTECODE=1 "${python_bin}" tests/test_prepare_usb_receiver.py
    PYTHONDONTWRITEBYTECODE=1 "${python_bin}" tests/test_prepare_desktop_zip.py
    "${CC:-cc}" -std=gnu11 -Wall -Wextra -Werror -Itests/qdd_onboarding_host -Imain \
        tests/test_qdd_download_assets.c -o "${test_dir}/test_qdd_download_assets"
    "${test_dir}/test_qdd_download_assets"
    "${CC:-cc}" -std=c11 -Wall -Wextra -Werror -pedantic -Itests/qdd_wifi_host -Imain \
        tests/test_qdd_wifi.c main/qdd_control.c main/qdd_net_config.c -o "${test_dir}/test_qdd_wifi"
    "${test_dir}/test_qdd_wifi"
    "${CC:-cc}" -std=c11 -Wall -Wextra -Werror -Imain \
        tests/test_ui_pixel_math.c main/ui_pixel_math.c \
        -o "${test_dir}/test_ui_pixel_math"
    "${test_dir}/test_ui_pixel_math"
    "${CC:-cc}" -std=c11 -Wall -Wextra -Werror -Imain \
        tests/test_demo_navigation.c main/demo_navigation.c \
        -o "${test_dir}/test_demo_navigation"
    "${test_dir}/test_demo_navigation"
    "${CC:-cc}" -std=c11 -Wall -Wextra -Werror -Imain \
        tests/test_key_guard.c -o "${test_dir}/test_key_guard"
    "${test_dir}/test_key_guard"
    "${CC:-cc}" -std=c11 -Wall -Wextra -Werror -Icomponents/bsp/src \
        tests/test_bsp_display_rounding.c components/bsp/src/bsp_display_rounding.c \
        -o "${test_dir}/test_bsp_display_rounding"
    "${test_dir}/test_bsp_display_rounding"
    "${CC:-cc}" -std=c11 -Wall -Wextra -Werror -Icomponents/bsp/src \
        tests/test_bsp_es8311_sleep_check.c components/bsp/src/bsp_es8311_sleep_check.c \
        -o "${test_dir}/test_bsp_es8311_sleep_check"
    "${test_dir}/test_bsp_es8311_sleep_check"
    "${CC:-cc}" -std=c11 -Wall -Wextra -Werror \
        -Itests/bsp_stubs -Icomponents/bsp/include \
        tests/test_bsp_button.c -o "${test_dir}/test_bsp_button"
    "${test_dir}/test_bsp_button"
    "${CC:-cc}" -std=c11 -Wall -Wextra -Werror \
        -Itests/bsp_stubs -Icomponents/bsp/include \
        tests/test_bsp_lvgl_init.c components/bsp/src/bsp_display_rounding.c \
        -o "${test_dir}/test_bsp_lvgl_init"
    "${test_dir}/test_bsp_lvgl_init"
    "${CC:-cc}" -std=c11 -Wall -Wextra -Werror \
        -Itests/bsp_stubs -Icomponents/bsp/include \
        tests/test_bsp_lvgl_buffer.c components/bsp/src/bsp_display_rounding.c \
        -o "${test_dir}/test_bsp_lvgl_buffer"
    for scenario in budget default min max invalid retry rounding; do
        "${test_dir}/test_bsp_lvgl_buffer" "${scenario}"
    done
    "${CC:-cc}" -std=c11 -Wall -Wextra -Werror \
        -Itests/audio_stubs -Icomponents/bsp/include -Icomponents/bsp/src \
        tests/test_bsp_audio_recovery.c components/bsp/src/bsp_es8311_sleep_check.c \
        -o "${test_dir}/test_bsp_audio_recovery"
    "${test_dir}/test_bsp_audio_recovery"
    for demo in audio low_power ble wifi; do
        "${CC:-cc}" -std=c11 -Wall -Wextra -Werror \
            "${demo_compiler_flags[@]}" -Itests/demo_stubs -Imain \
            "tests/test_demo_${demo}_runtime.c" -Wl,--gc-sections \
            -o "${test_dir}/test_demo_${demo}_runtime"
        "${test_dir}/test_demo_${demo}_runtime"
    done
    PYTHONDONTWRITEBYTECODE=1 "${python_bin}" tests/test_deep_sleep_contract.py
    PYTHONDONTWRITEBYTECODE=1 "${python_bin}" tests/test_key_wake_contract.py
    PYTHONDONTWRITEBYTECODE=1 "${python_bin}" tests/test_qdd_ble_contract.py
    PYTHONDONTWRITEBYTECODE=1 "${python_bin}" tests/test_qdd_text_integration.py
    PYTHONDONTWRITEBYTECODE=1 "${python_bin}" tests/test_qdd_fonts.py
    PYTHONDONTWRITEBYTECODE=1 "${python_bin}" tests/test_qdd_transport_contract.py
    PYTHONDONTWRITEBYTECODE=1 "${python_bin}" tests/test_check_repo.py
    PYTHONDONTWRITEBYTECODE=1 "${python_bin}" tests/test_verify_firmware.py
    PYTHONDONTWRITEBYTECODE=1 "${python_bin}" tests/test_archive_firmware.py
    PYTHONDONTWRITEBYTECODE=1 "${python_bin}" tests/test_pack_download_assets.py
    PYTHONDONTWRITEBYTECODE=1 "${python_bin}" tests/test_install_passport_skills.py
    rm -rf "${test_dir}"
    echo "Host tests: PASS"
}

run_firmware_checks() (
    local validation_build_dir
    local idf_build_dir
    local idf_repo_root
    local -a idf_command

    if "${windows_host}" && [[ -n "${IDF_PATH:-}" ]]; then
        # PowerShell already activated native Windows tools; Bash is only the gate runner.
        # idf.py otherwise sees MSYSTEM and exits without executing the requested action.
        # Clear its inherited Windows value before unsetting it in the MSYS child.
        idf_command=(env MSYSTEM= env -u MSYSTEM "${python_bin}" "$(cygpath -m "${IDF_PATH}")/tools/idf.py")
    elif command -v idf.py >/dev/null 2>&1; then
        idf_command=(idf.py)
    else
        echo "ERROR: idf.py is not available; activate ESP-IDF 5.5.3 first." >&2
        return 1
    fi

    validation_build_dir="$(mktemp -d /tmp/ai-passport-firmware.XXXXXX)"
    trap 'case "${validation_build_dir}" in /tmp/ai-passport-firmware.*) rm -rf -- "${validation_build_dir}" ;; esac' EXIT
    idf_build_dir="${validation_build_dir}"
    idf_repo_root="${repo_root}"
    if "${windows_host}"; then
        # Native CMake reads this environment value without MSYS argument conversion.
        idf_build_dir="$(cygpath -m "${validation_build_dir}")"
        idf_repo_root="$(cygpath -m "${repo_root}")"
    fi

    SDKCONFIG_DEFAULTS="${idf_repo_root}/sdkconfig.defaults" \
        "${idf_command[@]}" -B "${idf_build_dir}" \
        -D "SDKCONFIG=${idf_build_dir}/sdkconfig" build
    "${idf_command[@]}" -B "${idf_build_dir}" merge-bin \
        -o "${idf_build_dir}/FoloToy-AI-Passport-full.bin"
    "${python_bin}" tools/verify_firmware.py "${validation_build_dir}"
    PYTHONDONTWRITEBYTECODE=1 "${python_bin}" tools/archive_firmware.py create \
        "${validation_build_dir}" --archive-root "${repo_root}/build/firmware"
    mkdir -p "${repo_root}/build"
    install -m 0644 \
        "${validation_build_dir}/FoloToy-AI-Passport-full.bin" \
        "${repo_root}/build/FoloToy-AI-Passport-full.bin"
    echo "Firmware build: PASS"
)

cd "${repo_root}"
case "${mode}" in
    --all)
        run_static_checks
        run_firmware_checks
        ;;
    --static)
        run_static_checks
        ;;
    --firmware)
        run_firmware_checks
        ;;
    *)
        usage
        exit 2
        ;;
esac
