<p align="right">
  <a href="README.zh_CN.md">简体中文</a> · <strong>English</strong>
</p>

# AI Passport firmware workspace

`@qdd/esp` contains the FoloToy AI Passport ESP32-C3 hardware-test baseline,
integrated into this npm monorepo. It targets 8 MB Flash without PSRAM and uses
ESP-IDF **5.5.3**. The baseline is a starting point for future firmware work;
it does not yet connect the device to the QDD assistant.

Read [AGENTS.md](AGENTS.md) before development, then follow its task routing.
The [upstream documentation index](docs/README.md) and
[official tutorial](https://ai-passport.folotoy.cn/guides/create-a-play-with-agent/)
explain the hardware and development workflow. A derivative application must
design its own UI instead of reusing the baseline test menu and screens.

## Windows environment

Install ESP-IDF v5.5.3 using Espressif's official Windows Tools Installer.
Keep the installation outside this repository, in a path without spaces, and
include ESP32-C3 support. The
[environment guide](docs/development/engineering/environment-setup.md)
documents other platforms and official download routes.

The npm commands below start a child PowerShell and activate the selected IDF
installation with its official `export.ps1`. They do not change shell startup
files or global environment settings.

Choose an installation using `IDF_PATH`, or create the ignored local file:

```powershell
Copy-Item apps/esp/.idf.local.example.json apps/esp/.idf.local.json
```

Fill in the paths from your own installer. Relative paths resolve from
`apps/esp/`. Empty optional fields are ignored.

| Field | Purpose |
| --- | --- |
| `idfPath` | ESP-IDF checkout containing `export.ps1`, such as `C:/Espressif/frameworks/esp-idf-v5.5.3`. `IDF_PATH` takes precedence. |
| `toolsPath` | Installer tools directory, such as `C:/Espressif`. An existing `IDF_TOOLS_PATH` takes precedence. |
| `pythonPath` | Optional bootstrap `python.exe` from the installer, needed if Python is unavailable in the current shell. The activated IDF virtual environment runs subsequent commands. |
| `bashPath` | Git for Windows `bin/bash.exe`, required by the shared validation gate. If empty, the wrapper searches the Git installation; it does not use WSL Bash. |
| `ccPath` | Native host C compiler, required by the static/full gate. For example, use a portable w64devkit `bin/gcc.exe`. An existing `CC` takes precedence. |

Keep `.idf.local.json` local. It contains machine-specific paths and is ignored
by Git. The example file intentionally contains no installation-specific paths.

## Commands

Run these from the monorepo root after `npm ci`:

| Command | Behavior |
| --- | --- |
| `npm run check:esp` | Check ESP-IDF v5.5.3, Python, CMake, Ninja, and the RISC-V compiler. This is an environment check, not a firmware build or host test run. |
| `npm run build:esp` | Run the shared `tools/validate.sh --firmware` gate: build, merge, verify, and archive matching debugging artifacts. |
| `npm run validate:esp` | Run the complete shared gate, including repository checks, host tests, and the firmware gate. |
| `npm run validate:esp -- --static` | Run repository checks and host tests only. |
| `npm run idf:esp -- --version` | Run a native IDF command after activation and version validation. |
| `npm run idf:esp -- build` | Perform an incremental development build. |
| `npm run idf:esp -- menuconfig` | Open the native IDF configuration menu. |

Additional native IDF arguments are forwarded without rewriting them. For
example, `npm run idf:esp -- -B build/dev build` selects a separate incremental
build directory. Running `idf:esp` without arguments displays IDF help.

`check:esp`, `build:esp`, and `validate:esp` never flash a device. Flashing requires
an explicitly selected native IDF action and the authorization described in
[AGENTS.md](AGENTS.md). The monorepo's existing `npm run build`, `typecheck`, and
`clean` retain their TypeScript behavior; this C workspace has no TypeScript
project reference.

For Linux or macOS, activate ESP-IDF v5.5.3 and run `./tools/validate.sh` directly
from `apps/esp/`. The npm PowerShell wrapper targets native Windows.

## Build output

The firmware gate creates the verified merged image at
`build/FoloToy-AI-Passport-full.bin` and retains a matching manifest, ELF, MAP,
and component images under `build/firmware/<full-bin-sha256>/`. See
[build and test](docs/development/engineering/build-and-test.md) for validation
and archival details. A failed gate may leave earlier outputs in place; do not
treat an earlier image as the result of a failed run.

`build/`, generated `sdkconfig`, and `managed_components/` are ignored. The
tracked `dependencies.lock` pins ESP-IDF Managed Components independently of
the npm lockfile. Compilation and host tests do not prove on-device behavior.

## Source and local integration

- Source: [FoloToy/ai-passport on Gitee](https://gitee.com/FoloToy/ai-passport).
- Imported commit: `a06235e4c94361e3f8a2d498930254101718acae`.
- License: [MIT, Copyright (c) 2026 FoloToy](LICENSE); the upstream license and
  attribution are preserved.
- The source is vendored under `apps/esp/` without a nested `.git` directory.
  Upstream `main/`, BSP, partition table, and dependency declarations are
  retained for the initial integration.
- Local integration adds this README pair, the npm workspace manifest,
  ignored local environment configuration, a Windows IDF wrapper, and root npm
  entry points. The shared validation tools also support native Windows Python,
  IDF paths, and the Windows actionlint distribution.
- Future upstream updates must review the local integration changes together
  with the pinned commit and `dependencies.lock`; the nested upstream GitHub
  workflows do not automatically become monorepo workflows.
