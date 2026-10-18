#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0601
#include <windows.h>
#include <devguid.h>
#include <setupapi.h>
#include <bcrypt.h>
#include <commdlg.h>
#include <shellapi.h>
#include "transfer.h"
#include "hardware.h"

/* No C runtime/startup or external runtime DLL is required. */
void *memcpy(void *out, const void *in, size_t n) { unsigned char *d = out; const unsigned char *s = in; while (n--) *d++ = *s++; return out; }
void *memset(void *out, int value, size_t n) { unsigned char *d = out; while (n--) *d++ = (unsigned char)value; return out; }

typedef struct { WCHAR port[32], name[256], instance[256]; } device;
static device devices[32];
static unsigned device_count;
static HANDLE serial = INVALID_HANDLE_VALUE, file = INVALID_HANDLE_VALUE;
static WCHAR destination[32768], temporary[32768];
static BCRYPT_ALG_HANDLE algorithm;
static BCRYPT_HASH_HANDLE hash;
static void *hash_object;
static qdddrv_line lines;
static qdddrv_reply parsed;
static volatile LONG user_cancel;
static ULONGLONG deadline;
static DWORD last_error, last_id, read_requests, last_percent = 101;
static int timed_out;

static void text(const WCHAR *value) {
  const DWORD length = (DWORD)lstrlenW(value); DWORD written;
  HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
  if (WriteConsoleW(output, value, length, &written, NULL)) return;
  const int size = WideCharToMultiByte(CP_UTF8, 0, value, (int)length, NULL, 0, NULL, NULL);
  if (size <= 0) return;
  char *utf8 = HeapAlloc(GetProcessHeap(), 0, (SIZE_T)size);
  if (utf8) {
    WideCharToMultiByte(CP_UTF8, 0, value, (int)length, utf8, size, NULL, NULL);
    WriteFile(output, utf8, (DWORD)size, &written, NULL); HeapFree(GetProcessHeap(), 0, utf8);
  }
}
static void error_text(const WCHAR *message) {
  WCHAR detail[128];
  text(message);
  if (last_error) { wsprintfW(detail, L" (错误码 %lu)", last_error); text(detail); }
  text(L"\r\n");
}
static BOOL WINAPI console_event(DWORD event) {
  if (event == CTRL_C_EVENT || event == CTRL_BREAK_EVENT || event == CTRL_CLOSE_EVENT) {
    InterlockedExchange(&user_cancel, 1);
    if (serial != INVALID_HANDLE_VALUE) CancelIoEx(serial, NULL);
    return TRUE;
  }
  return FALSE;
}
static int same(const WCHAR *a, const WCHAR *b) { return CompareStringOrdinal(a, -1, b, -1, TRUE) == CSTR_EQUAL; }
static void enumerate(void) {
  HDEVINFO list = SetupDiGetClassDevsW(&GUID_DEVCLASS_PORTS, NULL, NULL, DIGCF_PRESENT);
  if (list == INVALID_HANDLE_VALUE) return;
  SP_DEVINFO_DATA item = {0}; item.cbSize = sizeof(item);
  for (DWORD index = 0; device_count < 32 && SetupDiEnumDeviceInfo(list, index, &item); ++index) {
    WCHAR hardware[1024]; DWORD bytes = 0, type = 0;
    if (!SetupDiGetDeviceRegistryPropertyW(list, &item, SPDRP_HARDWAREID, &type,
        (BYTE *)hardware, sizeof(hardware), &bytes) || type != REG_MULTI_SZ ||
        !qdddrv_usb_hardware_match((const uint16_t *)hardware, bytes)) continue;
    HKEY key = SetupDiOpenDevRegKey(list, &item, DICS_FLAG_GLOBAL, 0, DIREG_DEV, KEY_READ);
    if (key == INVALID_HANDLE_VALUE) continue;
    device *candidate = devices + device_count;
    bytes = sizeof(candidate->port); type = 0;
    const LONG result = RegQueryValueExW(key, L"PortName", NULL, &type, (BYTE *)candidate->port, &bytes);
    RegCloseKey(key);
    if (result != ERROR_SUCCESS || type != REG_SZ || bytes < 2 || (bytes & 1u) || bytes > sizeof(candidate->port) || candidate->port[bytes / 2u - 1u]) continue;
    if (lstrlenW(candidate->port) < 4 || CompareStringOrdinal(candidate->port, 3, L"COM", 3, TRUE) != CSTR_EQUAL) continue;
    int valid = 1;
    for (const WCHAR *p = candidate->port + 3; *p; ++p) if (*p < L'0' || *p > L'9') valid = 0;
    if (!valid) continue;
    SetupDiGetDeviceRegistryPropertyW(list, &item, SPDRP_FRIENDLYNAME, NULL, (BYTE *)candidate->name, sizeof(candidate->name), NULL);
    candidate->name[255] = 0;
    SetupDiGetDeviceInstanceIdW(list, &item, candidate->instance, 256, NULL); candidate->instance[255] = 0;
    ++device_count;
  }
  SetupDiDestroyDeviceInfoList(list);
}
static void show_devices(void) {
  text(L"仅列出 ESP USB VID 303A / PID 1001：\r\n");
  for (unsigned i = 0; i < device_count; ++i) {
    WCHAR number[40]; wsprintfW(number, L"%u. %s  ", i + 1u, devices[i].port);
    text(number); text(devices[i].name); text(L"\r\n   "); text(devices[i].instance); text(L"\r\n");
  }
}
static int open_serial(const WCHAR *port) {
  WCHAR path[48]; wsprintfW(path, L"\\\\.\\%s", port);
  serial = CreateFileW(path, GENERIC_READ | GENERIC_WRITE, 0, NULL, OPEN_EXISTING, 0, NULL);
  if (serial == INVALID_HANDLE_VALUE) { last_error = GetLastError(); return 0; }
  /* Request both modem outputs disabled as soon as the handle exists. */
  if (!EscapeCommFunction(serial, CLRDTR) || !EscapeCommFunction(serial, CLRRTS)) { last_error = GetLastError(); return 0; }
  DCB state = {0}; state.DCBlength = sizeof(state);
  if (!GetCommState(serial, &state)) { last_error = GetLastError(); return 0; }
  state.BaudRate = CBR_115200; state.ByteSize = 8; state.Parity = NOPARITY; state.StopBits = ONESTOPBIT;
  state.fBinary = TRUE; state.fParity = FALSE; state.fOutxCtsFlow = FALSE; state.fOutxDsrFlow = FALSE;
  state.fDtrControl = DTR_CONTROL_DISABLE; state.fDsrSensitivity = FALSE; state.fTXContinueOnXoff = TRUE;
  state.fOutX = FALSE; state.fInX = FALSE; state.fErrorChar = FALSE; state.fNull = FALSE;
  state.fRtsControl = RTS_CONTROL_DISABLE; state.fAbortOnError = FALSE;
  COMMTIMEOUTS timeouts = {MAXDWORD, 0, 50, 0, 1000};
  if (!SetCommState(serial, &state) || !SetCommTimeouts(serial, &timeouts) ||
      !PurgeComm(serial, PURGE_RXCLEAR | PURGE_TXCLEAR)) { last_error = GetLastError(); return 0; }
  return 1;
}
static int write_command(const char *command) {
  DWORD length = (DWORD)lstrlenA(command);
  while (length) {
    DWORD written = 0;
    if (!WriteFile(serial, command, length, &written, NULL) || !written) { last_error = GetLastError(); return 0; }
    command += written; length -= written;
  }
  return 1;
}
static int wait_reply(uint32_t id, DWORD timeout, int cleanup, qdddrv_reply *reply) {
  const ULONGLONG started = GetTickCount64();
  while (GetTickCount64() - started < timeout) {
    if (!cleanup && (user_cancel || GetTickCount64() >= deadline)) {
      if (!user_cancel) timed_out = 1;
      return -1;
    }
    BYTE bytes[256]; DWORD count = 0;
    if (!ReadFile(serial, bytes, sizeof(bytes), &count, NULL)) { last_error = GetLastError(); return -1; }
    for (DWORD i = 0; i < count; ++i) {
      if (qdddrv_line_feed(&lines, bytes[i]) && qdddrv_parse(lines.bytes, &parsed) && parsed.id == id) {
        *reply = parsed; return 1;
      }
    }
  }
  last_error = ERROR_TIMEOUT; return 0;
}
static int exchange(void *context, qdddrv_command command, uint32_t id, const char *session,
                    uint32_t offset, uint32_t length, qdddrv_reply *reply) {
  (void)context; char request[128]; last_id = id;
  if (command == QDDDRV_REQUEST_INFO) wsprintfA(request, "QDDDRV/1 %lu INFO\n", id);
  else { ++read_requests; wsprintfA(request, "QDDDRV/1 %lu READ %s %lu %lu\n", id, session, offset, length); }
  if (!write_command(request)) return -1;
  const int result = wait_reply(id, 4000, 0, reply);
  if (result == 1 && reply->kind == QDDDRV_ERR) {
    WCHAR message[80]; MultiByteToWideChar(CP_UTF8, 0, reply->error, -1, message, 80);
    text(L"设备回复："); text(message); text(L"\r\n");
    if (lstrcmpA(reply->error, "CONTROL_BUSY") == 0) text(L"请先停止手机控制、退出设备设置，再重试 USB 下载。\r\n");
    else if (lstrcmpA(reply->error, "BUSY") == 0) text(L"设备正在处理下载任务，请稍后重试。\r\n");
    else if (lstrcmpA(reply->error, "ASSET_ERROR") == 0) text(L"安装包资源缺失或校验失败，已拒绝保存。\r\n");
    else if (lstrcmpA(reply->error, "STALE_SESSION") == 0) text(L"USB 会话已失效，只允许核对同一安装包后恢复一次。\r\n");
  }
  return result;
}
static int append(void *context, const uint8_t *bytes, uint32_t size) {
  (void)context; const BYTE *cursor = bytes; DWORD remaining = size;
  while (remaining) {
    DWORD written = 0;
    if (!WriteFile(file, cursor, remaining, &written, NULL) || !written) { last_error = GetLastError(); return 0; }
    cursor += written; remaining -= written;
  }
  if (BCryptHashData(hash, (PUCHAR)bytes, size, 0) < 0) { last_error = ERROR_CRC; return 0; }
  return 1;
}
static int verify(void *context, const uint8_t *expected) {
  (void)context; BYTE digest[32];
  if (BCryptFinishHash(hash, digest, sizeof(digest), 0) < 0) return 0;
  unsigned different = 0; for (unsigned i = 0; i < sizeof(digest); ++i) different |= digest[i] ^ expected[i];
  return different == 0;
}
static int cancelled(void *context) {
  (void)context;
  if (GetTickCount64() >= deadline) timed_out = 1;
  return user_cancel || timed_out;
}
static void progress(void *context, uint32_t offset, uint32_t total) {
  (void)context; const DWORD percent = (DWORD)(((ULONGLONG)offset * 100u) / total);
  if (percent != last_percent) {
    WCHAR status[128]; wsprintfW(status, L"\r已校验 %lu / %lu 字节  (%lu%%)   ", offset, total, percent);
    text(status); last_percent = percent;
  }
}
static int init_sha(void) {
  DWORD length = 0, actual = 0, digest_size = 0;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, NULL, 0) < 0 ||
      BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, (PUCHAR)&length, sizeof(length), &actual, 0) < 0 ||
      !length || length > 65536 ||
      BCryptGetProperty(algorithm, BCRYPT_HASH_LENGTH, (PUCHAR)&digest_size, sizeof(digest_size), &actual, 0) < 0 || digest_size != 32) return 0;
  hash_object = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, length);
  return hash_object && BCryptCreateHash(algorithm, &hash, hash_object, length, NULL, 0, 0) >= 0;
}
static void cleanup(const char *session) {
  if (serial != INVALID_HANDLE_VALUE && *session) {
    char request[128]; qdddrv_reply reply;
    if (!++last_id) ++last_id;
    wsprintfA(request, "QDDDRV/1 %lu CANCEL %s\n", last_id, session);
    if (write_command(request)) (void)wait_reply(last_id, 500, 1, &reply);
  }
  if (serial != INVALID_HANDLE_VALUE) { CloseHandle(serial); serial = INVALID_HANDLE_VALUE; }
  if (file != INVALID_HANDLE_VALUE) { CloseHandle(file); file = INVALID_HANDLE_VALUE; }
  if (*temporary) {
    int removed = 0;
    for (unsigned attempt = 0; attempt < 3 && !removed; ++attempt) {
      removed = DeleteFileW(temporary) || GetLastError() == ERROR_FILE_NOT_FOUND;
      if (!removed) Sleep(50);
    }
    if (removed) *temporary = 0;
    else { text(L"临时文件清理失败，请删除："); text(temporary); text(L"\r\n"); }
  }
  if (hash) { BCryptDestroyHash(hash); hash = NULL; }
  if (hash_object) { HeapFree(GetProcessHeap(), 0, hash_object); hash_object = NULL; }
  if (algorithm) { BCryptCloseAlgorithmProvider(algorithm, 0); algorithm = NULL; }
}
static int publish(void) {
  if (!FlushFileBuffers(file)) { last_error = GetLastError(); return 0; }
  if (user_cancel) { last_error = ERROR_CANCELLED; return 0; }
  CloseHandle(file); file = INVALID_HANDLE_VALUE;
  if (!MoveFileExW(temporary, destination, MOVEFILE_WRITE_THROUGH)) { last_error = GetLastError(); return 0; }
  *temporary = 0; return 1;
}
static int file_self_test(void) {
  static WCHAR folder[32768];
  DWORD length = GetTempPathW(32600, folder), count = 0;
  if (!length || length >= 32600) return 0;
  wsprintfW(folder + length, L"qdd-usb-selftest-%lu-%lu", GetCurrentProcessId(), GetTickCount());
  if (!CreateDirectoryW(folder, NULL)) return 0;
  lstrcpyW(destination, folder); lstrcatW(destination, L"\\result.zip");
  lstrcpyW(temporary, folder); lstrcatW(temporary, L"\\result.tmp");
  HANDLE target = CreateFileW(destination, GENERIC_WRITE, 0, NULL, CREATE_NEW, 0, NULL);
  int passed = 0;
  if (target == INVALID_HANDLE_VALUE) goto done;
  const BOOL sentinel = WriteFile(target, "original", 8, &count, NULL); CloseHandle(target);
  if (!sentinel || count != 8) goto done;
  file = CreateFileW(temporary, GENERIC_WRITE, 0, NULL, CREATE_NEW, 0, NULL);
  if (file == INVALID_HANDLE_VALUE || !WriteFile(file, "abc", 3, &count, NULL) || count != 3 || publish()) goto done;
  cleanup(""); cleanup("");
  if (GetFileAttributesW(temporary) != INVALID_FILE_ATTRIBUTES && *temporary) goto done;
  target = CreateFileW(destination, GENERIC_READ, 0, NULL, OPEN_EXISTING, 0, NULL);
  char data[8];
  if (target == INVALID_HANDLE_VALUE) goto done;
  const BOOL unchanged = ReadFile(target, data, sizeof(data), &count, NULL); CloseHandle(target);
  if (!unchanged || count != 8) goto done;
  for (unsigned i = 0; i < 8; ++i) if (data[i] != "original"[i]) goto done;
  if (!DeleteFileW(destination)) goto done;
  lstrcpyW(temporary, folder); lstrcatW(temporary, L"\\result.tmp");
  file = CreateFileW(temporary, GENERIC_WRITE, 0, NULL, CREATE_NEW, 0, NULL);
  if (file == INVALID_HANDLE_VALUE || !WriteFile(file, "abc", 3, &count, NULL) || count != 3 || !publish()) goto done;
  target = CreateFileW(destination, GENERIC_READ, 0, NULL, OPEN_EXISTING, 0, NULL);
  if (target == INVALID_HANDLE_VALUE) goto done;
  const BOOL saved = ReadFile(target, data, sizeof(data), &count, NULL); CloseHandle(target);
  passed = saved && count == 3 && data[0] == 'a' && data[1] == 'b' && data[2] == 'c';
done:
  cleanup("");
  if (GetFileAttributesW(destination) != INVALID_FILE_ATTRIBUTES && !DeleteFileW(destination)) passed = 0;
  if (!RemoveDirectoryW(folder)) passed = 0;
  *destination = 0; *temporary = 0;
  return passed;
}
static int self_test(void) {
  qdddrv_reply reply;
  if (qdddrv_crc32((const uint8_t *)"123456789", 9) != 0xcbf43926u ||
      !qdddrv_parse("QDDDRV/1 1 INFO 0000000000000001 3 ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad ZIP", &reply) ||
      !init_sha() || BCryptHashData(hash, (PUCHAR)"abc", 3, 0) < 0 || !verify(NULL, reply.sha)) return 1;
  cleanup(""); cleanup("");
  if (!init_sha() || BCryptHashData(hash, (PUCHAR)"abc", 3, 0) < 0 || !verify(NULL, reply.sha)) return 1;
  cleanup(""); cleanup("");
  if (!file_self_test()) return 1;
  text(L"{\"status\":\"ok\",\"protocol\":\"QDDDRV/1\",\"selfTest\":true,\"noOverwrite\":true,\"atomicFileFixture\":true}\r\n"); return 0;
}
static int run(int count, WCHAR **args) {
  const WCHAR *port = NULL, *path = NULL;
  for (int i = 1; i < count; ++i) {
    if (same(args[i], L"--self-test")) return self_test();
    if (same(args[i], L"--port") && i + 1 < count) port = args[++i];
    else if (same(args[i], L"--output") && i + 1 < count) path = args[++i];
    else if (same(args[i], L"--list")) { enumerate(); show_devices(); return 0; }
    else { text(L"用法：设备USB下载器.exe [--list] [--port COM6 --output 完整路径.zip]\r\n"); return 2; }
  }
  enumerate(); show_devices();
  if (!device_count) { text(L"没有找到 ESP USB 设备。请连接 USB 数据线，并关闭占用串口的软件。\r\n"); return 3; }
  unsigned selected = 0;
  if (port) {
    int found = 0;
    for (unsigned i = 0; i < device_count; ++i) if (same(port, devices[i].port)) { selected = i; found = 1; break; }
    if (!found) { text(L"指定串口不在 VID303A/PID1001 设备列表中，未打开串口。\r\n"); return 3; }
  } else if (device_count > 1) {
    WCHAR choice[32]; DWORD read = 0; text(L"请输入设备序号：");
    if (!ReadConsoleW(GetStdHandle(STD_INPUT_HANDLE), choice, 31, &read, NULL) || !read) return 2;
    unsigned value = 0;
    for (DWORD i = 0; i < read && choice[i] != L'\r' && choice[i] != L'\n'; ++i) {
      if (choice[i] < L'0' || choice[i] > L'9' || value > 32) return 2;
      value = value * 10u + (unsigned)(choice[i] - L'0');
    }
    if (!value || value > device_count) return 2;
    selected = value - 1u;
  }
  if (path) {
    const DWORD length = GetFullPathNameW(path, 32700, destination, NULL);
    if (!length || length >= 32700) { text(L"保存路径无效或过长。\r\n"); return 2; }
  } else {
    lstrcpyW(destination, L"设备操作台.zip");
    OPENFILENAMEW save = {0}; save.lStructSize = sizeof(save); save.lpstrFilter = L"ZIP 安装包\0*.zip\0\0";
    save.lpstrFile = destination; save.nMaxFile = 32700; save.lpstrDefExt = L"zip";
    save.lpstrTitle = L"保存设备操作台 ZIP（不会自动运行）";
    save.Flags = OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR | OFN_HIDEREADONLY | OFN_EXPLORER;
    if (!GetSaveFileNameW(&save)) {
      last_error = CommDlgExtendedError();
      if (last_error) { error_text(L"保存对话框打开失败，未打开串口"); return 2; }
      text(L"已取消，未打开串口。\r\n"); return 130;
    }
  }
  if (GetFileAttributesW(destination) != INVALID_FILE_ATTRIBUTES) { text(L"目标文件已存在；请换一个文件名。不会覆盖原文件。\r\n"); return 4; }
  if (lstrlenW(destination) < 4 || !same(destination + lstrlenW(destination) - 4, L".zip")) {
    text(L"保存文件名必须以 .zip 结尾。\r\n"); return 2;
  }
  lstrcpyW(temporary, destination);
  wsprintfW(temporary + lstrlenW(temporary), L".qdd-%lu-%lu.tmp", GetCurrentProcessId(), GetTickCount());
  file = CreateFileW(temporary, GENERIC_WRITE, 0, NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
  if (file == INVALID_HANDLE_VALUE) { last_error = GetLastError(); error_text(L"无法创建临时文件"); *temporary = 0; return 4; }
  if (!init_sha()) { last_error = ERROR_CRC; error_text(L"无法初始化 Windows SHA-256"); return 5; }
  if (!open_serial(devices[selected].port)) { error_text(L"无法打开选定的 ESP USB 串口"); return 5; }
  text(L"USB 只读下载中。请勿拔线；Ctrl+C 可取消。不会启动主操作台。\r\n");
  const ULONGLONG started = GetTickCount64(); deadline = started + 180000u;
  DWORD seed = GetTickCount();
  (void)BCryptGenRandom(NULL, (PUCHAR)&seed, sizeof(seed), BCRYPT_USE_SYSTEM_PREFERRED_RNG);
  qdddrv_io io = {NULL, seed, exchange, append, verify, cancelled, progress};
  static qdddrv_reply info;
  const qdddrv_result result = qdddrv_transfer(&io, &info);
  /* CANCEL is independent read-session cleanup; it never sends HID/ARM/PAUSE. */
  if (result == QDDDRV_TRANSFER_OK && !user_cancel && !timed_out) {
    if (publish()) {
      WCHAR summary[192]; wsprintfW(summary, L"\r\n完成：%lu 字节，%lu 毫秒，整包 SHA-256 已核验。\r\n", info.size, (DWORD)(GetTickCount64() - started));
      text(summary); text(destination); text(L"\r\n请自行解压 ZIP；下载器不会运行 EXE。\r\n");
      WCHAR digest[65], report[256]; const WCHAR *digits = L"0123456789abcdef";
      for (unsigned i = 0; i < 32; ++i) { digest[i * 2] = digits[info.sha[i] >> 4]; digest[i * 2 + 1] = digits[info.sha[i] & 15]; }
      digest[64] = 0;
      wsprintfW(report, L"{\"status\":\"ok\",\"bytes\":%lu,\"durationMs\":%lu,\"readRequests\":%lu,\"sha256\":\"%s\"}\r\n",
        info.size, (DWORD)(GetTickCount64() - started), read_requests, digest);
      text(report);
      cleanup(info.session); return 0;
    }
    error_text(L"原子保存失败（现有文件不会覆盖）");
  } else if (result == QDDDRV_TRANSFER_CANCELLED || user_cancel || timed_out) {
    text(timed_out ? L"\r\n超过三分钟总时限，未保存 ZIP。\r\n" : L"\r\n已取消，未保存 ZIP。\r\n");
  } else if (result == QDDDRV_TRANSFER_SHA) text(L"\r\n整包 SHA-256 不符，已拒绝保存。\r\n");
  else error_text(L"\r\n下载未完成或协议校验失败；请检查设备固件/USB 连接后重试");
  cleanup(info.session); return user_cancel ? 130 : timed_out ? 124 : 6;
}
void usb_main(void) {
  int count = 0; WCHAR **args = CommandLineToArgvW(GetCommandLineW(), &count);
  SetConsoleCtrlHandler(console_event, TRUE);
  const int result = args ? run(count, args) : 2;
  cleanup("");
  if (count == 1) { WCHAR ignored[2]; DWORD read; text(L"按回车关闭。\r\n"); ReadConsoleW(GetStdHandle(STD_INPUT_HANDLE), ignored, 2, &read, NULL); }
  if (args) LocalFree(args);
  ExitProcess((UINT)result);
}
