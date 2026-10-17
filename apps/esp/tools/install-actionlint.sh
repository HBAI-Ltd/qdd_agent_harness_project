#!/usr/bin/env bash
set -euo pipefail

version="1.7.12"
destination="${1:-/tmp/actionlint-${version}}"
system_name="$(uname -s)"
machine_name="$(uname -m)"

archive_extension="tar.gz"
executable="actionlint"

case "${system_name}/${machine_name}" in
    Linux/x86_64)
        platform="linux_amd64"
        checksum="8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8"
        ;;
    Linux/aarch64|Linux/arm64)
        platform="linux_arm64"
        checksum="325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6"
        ;;
    Darwin/x86_64)
        platform="darwin_amd64"
        checksum="5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644"
        ;;
    Darwin/arm64)
        platform="darwin_arm64"
        checksum="aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f"
        ;;
    MINGW*/x86_64|MSYS*/x86_64|CYGWIN*/x86_64)
        platform="windows_amd64"
        checksum="6e7241b51e6817ea6a047693d8e6fed13b31819c9a0dd6c5a726e1592d22f6e9"
        archive_extension="zip"
        executable="actionlint.exe"
        ;;
    MINGW*/aarch64|MINGW*/arm64|MSYS*/aarch64|MSYS*/arm64|CYGWIN*/aarch64|CYGWIN*/arm64)
        platform="windows_arm64"
        checksum="cadcf7ea4efe3a68728893813643cebe1185e5b1d4be5b96245f65c9a4d5ea41"
        archive_extension="zip"
        executable="actionlint.exe"
        ;;
    *)
        echo "Unsupported actionlint platform: ${system_name}/${machine_name}" >&2
        exit 1
        ;;
esac

if [[ -x "${destination}/${executable}" ]]; then
    printf '%s\n' "${destination}/${executable}"
    exit 0
fi

archive_name="actionlint_${version}_${platform}.${archive_extension}"
archive_path="${destination}/${archive_name}"
download_url="https://github.com/rhysd/actionlint/releases/download/v${version}/${archive_name}"

mkdir -p "${destination}"
if ! curl --fail --location --silent --show-error --retry 3 --retry-all-errors \
    "${download_url}" --output "${archive_path}"; then
    if ! command -v gh >/dev/null 2>&1; then
        echo "actionlint download failed and GitHub CLI is unavailable" >&2
        exit 1
    fi
    rm -f "${archive_path}"
    gh release download "v${version}" --repo rhysd/actionlint \
        --pattern "${archive_name}" --dir "${destination}"
fi
if command -v sha256sum >/dev/null 2>&1; then
    printf '%s  %s\n' "${checksum}" "${archive_path}" | sha256sum --check --status
elif command -v shasum >/dev/null 2>&1; then
    [[ "$(shasum -a 256 "${archive_path}" | awk '{print $1}')" == "${checksum}" ]]
else
    echo "No SHA-256 verification tool is available" >&2
    exit 1
fi
if [[ "${archive_extension}" == "zip" ]]; then
    unzip -oq "${archive_path}" "${executable}" -d "${destination}"
else
    tar -xzf "${archive_path}" -C "${destination}" "${executable}"
fi
chmod +x "${destination}/${executable}"
printf '%s\n' "${destination}/${executable}"
