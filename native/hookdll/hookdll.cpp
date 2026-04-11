#include <windows.h>
#include <winsock2.h>
#include <ws2tcpip.h>

#include <cstdint>
#include <cstring>
#include <cstdio>
#include <cwctype>
#include <string>
#include <unordered_set>
#include <unordered_map>
#include <vector>

#include "MinHook.h"

#pragma comment(lib, "ws2_32.lib")

namespace {

constexpr const char* kVersion = "rb-hook-7.2.13-alpha8";
constexpr const char* kUdpHost = "127.0.0.1";
constexpr uint16_t kUdpPort = 22346;

// 7.2.13 で確認された operateLongValueChange 候補
constexpr const char* kOlvcSigPrimary =
    "48 89 5c 24 08 48 89 6c 24 10 48 89 74 24 18 48 89 7c 24 20 41 56 48 83 ec 60 41 8b f1";
// 旧版向けフォールバック（念のため）
constexpr const char* kOlvcSigFallback =
    "48 8B C4 41 56 48 83 EC 60 48 C7 40 C8 FE FF FF FF 48 89 58 08 48 89 68 10 48 89 70 18 48 89 78 20 41 8B";
// 7.x eventLoadFile 候補（曲ロード直後に track_browser_id を取得する）
constexpr const char* kLoadFileSig708 =
    "48 8B C4 55 53 56 57 41 54 41 55 41 56 41 57 48 8D A8 E8 FE FF FF 48 81 EC D8 01 00 00 C5 F8 29 70 A8 C5 F8 29 78 98 C5 78 29 40 88";
constexpr const char* kLoadFileSig670 =
    "4C 89 4C 24 20 4C 89 44 24 18 48 89 54 24 10 48 89 4C 24 08 55 53 56 57 41 54 41 55 41 56 41 57 48 8D 6C 24 F9";
// 7.x MainComponent 参照（UiManager -> UiPlayer*4 を辿る）
constexpr const char* kMainComponentSig7 =
    "48 89 5C 24 10 48 89 74 24 18 55 57 41 54 41 56 41 57 48 8D 6C 24 B0 48 81 EC 50 01 00 00";
// 7.0.1+ getInstance（TrackBrowser singleton を返す）
constexpr const char* kGetInstanceSig =
    "48 89 5c 24 18 57 48 83 ec 30 48 8b 05 ?? ?? ?? ??";
// 7.x 内部 getRowDataTrack(this, trackBrowserId, outRowData, 1, 0)
constexpr const char* kGetRowDataTrackSig =
    "48 89 5C 24 08 57 48 83 EC 20 49 8B D8 8B FA 44";
// db::RowDataTrack::RowDataTrack(rowData)
constexpr const char* kInitRowDataTrackSig =
    "48 89 5C 24 18 48 89 4C 24 08 55 56 57 48 83 EC 20 48 8B F1";
// db::RowDataTrack::~RowDataTrack(rowData)
constexpr const char* kDestrRowDataTrackSig =
    "48 89 5C 24 08 57 48 83 EC 20 48 8D 05 ?? ?? ?? ?? 48 8B D9 48 89 01 48 8D 05 ?? ?? ?? ?? 48 89 41 38 48 81 C1 C0 04 00 00 E8 ?? ?? ?? ?? 48";
// notifyMasterChange (7.x: RekordBoxSongExporter 準拠)
constexpr const char* kNotifyMasterChangeSig708 =
    "48 89 5C 24 18 48 89 74 24 20 55 57 41 54 41 56 41 57 48 8D 6C 24 B9";
constexpr const char* kNotifyMasterChangeSigFallback =
    "48 8B C4 55 53 56 57 41 54 41 55 41 56 41 57 48 8D A8 C8 FE FF FF";

using OlvcFn = uintptr_t(__fastcall*)(uintptr_t, uintptr_t, uintptr_t, uintptr_t);
using LoadFileFn = uintptr_t(__fastcall*)(uintptr_t, uintptr_t, uintptr_t, uintptr_t);
using NotifyMasterChangeFn = uintptr_t(__fastcall*)(uintptr_t, uintptr_t, uintptr_t, uintptr_t);
using GetInstanceFn = uintptr_t(*)();
using GetRowDataTrackFn = uintptr_t(__fastcall*)(uintptr_t, uint32_t, uintptr_t, uint32_t, uint32_t);
using InitRowDataTrackFn = uintptr_t(__fastcall*)(uintptr_t);
using DestrRowDataTrackFn = uintptr_t(__fastcall*)(uintptr_t);

SOCKET g_socket = INVALID_SOCKET;
sockaddr_in g_destination = {};
OlvcFn g_originalOlvc = nullptr;
LoadFileFn g_originalLoadFile = nullptr;
NotifyMasterChangeFn g_originalNotifyMasterChange = nullptr;
GetInstanceFn g_getInstance = nullptr;
GetRowDataTrackFn g_getRowDataTrack = nullptr;
InitRowDataTrackFn g_initRowDataTrack = nullptr;
DestrRowDataTrackFn g_destrRowDataTrack = nullptr;
bool g_olvcHookInstalled = false;
bool g_loadFileHookInstalled = false;
bool g_masterChangeHookInstalled = false;
ULONGLONG g_lastProbeTick[8] = {};
uintptr_t g_playerSlots[4] = {};
bool g_playerSlotsTried = false;
bool g_playerSlotsResolved = false;
uint32_t g_lastPlayerTrackId[4] = {};
uint32_t g_lastPlayerPrimaryCandidate[4] = {};
uint32_t g_lastPlayerStableCandidate[4] = {};
uint8_t g_lastPlayerStableHits[4] = {};
ULONGLONG g_lastPlayerProbeTick[4] = {};
uint32_t g_lastTitleHash[4] = {};
uint32_t g_lastArtistHash[4] = {};
ULONGLONG g_lastRowDataDiagTick[4] = {};
uint32_t g_trackIdHits[4] = {};
uint32_t g_trackIdMisses[4] = {};
uint32_t g_loadDetourHits = 0;
ULONGLONG g_lastTrackDiagLogTick = 0;
ULONGLONG g_lastLoadDetourLogTick = 0;

std::string wchar_to_utf8(const wchar_t* wstr) {
  if (!wstr) return "";
  int size = WideCharToMultiByte(CP_UTF8, 0, wstr, -1, nullptr, 0, nullptr, nullptr);
  if (size <= 1) return "";
  std::string result(static_cast<size_t>(size - 1), '\0');
  WideCharToMultiByte(CP_UTF8, 0, wstr, -1, &result[0], size, nullptr, nullptr);
  return result;
}

uint32_t simple_hash(const std::string& s) {
  uint32_t h = 5381;
  for (unsigned char c : s) { h = h * 33 + c; }
  return h;
}

// 文字列として妥当かどうか（ASCII + 2バイト以上の連続した非ASCII を許容）
bool looks_like_string(const char* p, size_t max_len) {
  if (!p || IsBadReadPtr(p, 1)) return false;
  size_t i = 0;
  for (; i < max_len && p[i] != '\0'; ++i) {
    unsigned char c = static_cast<unsigned char>(p[i]);
    if (c < 0x09) return false;  // 制御文字は拒否（タブ/改行は可）
  }
  return i > 0;
}

std::string escape_json(const char* input) {
  if (!input) {
    return "";
  }
  std::string out;
  out.reserve(64);
  for (const char* p = input; *p; ++p) {
    switch (*p) {
      case '\"':
        out += "\\\"";
        break;
      case '\\':
        out += "\\\\";
        break;
      case '\r':
        out += "\\r";
        break;
      case '\n':
        out += "\\n";
        break;
      case '\t':
        out += "\\t";
        break;
      default:
        out.push_back(*p);
        break;
    }
  }
  return out;
}

void send_packet(const std::string& payload) {
  if (g_socket == INVALID_SOCKET || payload.empty()) {
    return;
  }
  sendto(g_socket, payload.c_str(), static_cast<int>(payload.size()), 0,
         reinterpret_cast<const sockaddr*>(&g_destination), sizeof(g_destination));
}

void send_error(const char* message) {
  char buffer[512] = {};
  _snprintf_s(buffer, sizeof(buffer), _TRUNCATE,
              "{\"type\":\"error\",\"message\":\"%s\"}",
              escape_json(message).c_str());
  send_packet(buffer);
}

bool safe_read_u32(uintptr_t address, uint32_t& outValue) {
  if (IsBadReadPtr(reinterpret_cast<const void*>(address), sizeof(uint32_t))) {
    return false;
  }
  outValue = *reinterpret_cast<uint32_t*>(address);
  return true;
}

bool safe_read_ptr(uintptr_t address, uintptr_t& outValue) {
  if (IsBadReadPtr(reinterpret_cast<const void*>(address), sizeof(uintptr_t))) {
    return false;
  }
  outValue = *reinterpret_cast<uintptr_t*>(address);
  return true;
}

bool safe_read_i32(uintptr_t address, int32_t& outValue) {
  if (IsBadReadPtr(reinterpret_cast<const void*>(address), sizeof(int32_t))) {
    return false;
  }
  outValue = *reinterpret_cast<int32_t*>(address);
  return true;
}

void try_add_candidate(uint32_t value, std::unordered_set<uint32_t>& seen,
                       std::vector<uint32_t>& candidates) {
  if (value < 1000000 || value > 500000000) {
    return;
  }
  if (seen.insert(value).second) {
    candidates.push_back(value);
  }
}

std::vector<uint32_t> probe_content_id_candidates(uintptr_t contextPtr) {
  std::vector<uint32_t> candidates;
  if (!contextPtr) {
    return candidates;
  }
  std::unordered_set<uint32_t> seen;

  // 1) Direct scan around context object
  for (uintptr_t offset = 0; offset <= 0x1C0; offset += 4) {
    uint32_t value = 0;
    if (!safe_read_u32(contextPtr + offset, value)) {
      continue;
    }
    try_add_candidate(value, seen, candidates);
    if (candidates.size() >= 24) {
      return candidates;
    }
  }

  // 2) One-level pointer scan (often where model fields are stored)
  for (uintptr_t offset = 0; offset <= 0x120; offset += 8) {
    uintptr_t ptrValue = 0;
    if (!safe_read_ptr(contextPtr + offset, ptrValue)) {
      continue;
    }
    if (ptrValue < 0x10000 || ptrValue > 0x00007FFFFFFFFFFFULL) {
      continue;
    }
    if (IsBadReadPtr(reinterpret_cast<const void*>(ptrValue), 0x80)) {
      continue;
    }
    for (uintptr_t inner = 0; inner <= 0x40; inner += 4) {
      uint32_t value = 0;
      if (!safe_read_u32(ptrValue + inner, value)) {
        continue;
      }
      try_add_candidate(value, seen, candidates);
      if (candidates.size() >= 24) {
        return candidates;
      }
    }
  }
  return candidates;
}

std::vector<uint32_t> probe_loadinfo_candidates(uintptr_t loadInfoPtr) {
  std::vector<uint32_t> candidates;
  if (!loadInfoPtr) {
    return candidates;
  }
  std::unordered_set<uint32_t> seen;

  for (uintptr_t offset = 0; offset <= 0x90; offset += 4) {
    uint32_t value = 0;
    if (!safe_read_u32(loadInfoPtr + offset, value)) {
      continue;
    }
    try_add_candidate(value, seen, candidates);
    if (candidates.size() >= 24) {
      return candidates;
    }
  }

  for (uintptr_t offset = 0; offset <= 0x50; offset += 8) {
    uintptr_t ptrValue = 0;
    if (!safe_read_ptr(loadInfoPtr + offset, ptrValue)) {
      continue;
    }
    if (ptrValue < 0x10000 || ptrValue > 0x00007FFFFFFFFFFFULL) {
      continue;
    }
    if (IsBadReadPtr(reinterpret_cast<const void*>(ptrValue), 0x40)) {
      continue;
    }
    for (uintptr_t inner = 0; inner <= 0x20; inner += 4) {
      uint32_t value = 0;
      if (!safe_read_u32(ptrValue + inner, value)) {
        continue;
      }
      try_add_candidate(value, seen, candidates);
      if (candidates.size() >= 24) {
        return candidates;
      }
    }
  }

  return candidates;
}

void send_cid_probe(uintptr_t deckRaw, const std::vector<uint32_t>& candidates) {
  if (candidates.empty()) {
    return;
  }
  std::string payload = "{\"type\":\"cid_probe\",\"deck\":";
  payload += std::to_string(static_cast<unsigned long long>(deckRaw));
  payload += ",\"candidates\":[";
  for (size_t i = 0; i < candidates.size(); ++i) {
    if (i > 0) {
      payload.push_back(',');
    }
    payload += std::to_string(static_cast<unsigned long long>(candidates[i]));
  }
  payload += "]}";
  send_packet(payload);
}

void send_track_load(int deckRaw, uint32_t contentId, uintptr_t playerPtr, uintptr_t arg3, uintptr_t arg4) {
  if (contentId == 0) {
    return;
  }
  char buffer[256] = {};
  _snprintf_s(
      buffer, sizeof(buffer), _TRUNCATE,
      "{\"type\":\"track_load\",\"deck\":%d,\"contentId\":%llu,\"player\":%llu,\"arg3\":%llu,\"arg4\":%llu}",
      deckRaw,
      static_cast<unsigned long long>(contentId),
      static_cast<unsigned long long>(playerPtr),
      static_cast<unsigned long long>(arg3),
      static_cast<unsigned long long>(arg4));
  send_packet(buffer);
}

void send_track_load_log(int deckRaw, uint32_t contentId) {
  char buffer[192] = {};
  _snprintf_s(
      buffer, sizeof(buffer), _TRUNCATE,
      "{\"type\":\"log\",\"message\":\"Track load observed (deck=%d, contentId=%llu)\"}",
      deckRaw,
      static_cast<unsigned long long>(contentId));
  send_packet(buffer);
}

bool is_likely_valid_track_text(const std::wstring& text) {
  if (text.empty() || text.size() > 256) {
    return false;
  }
  size_t meaningful = 0;
  for (wchar_t wc : text) {
    if (wc == 0 || wc == L'\r' || wc == L'\n' || wc == L'\t') {
      return false;
    }
    if (wc < 0x20 || (wc >= 0xD800 && wc <= 0xDFFF) || (wc >= 0x4DC0 && wc <= 0x4DFF)) {
      return false;
    }
    if (!iswspace(wc) && !iswcntrl(wc) && wc != L'-' && wc != L'_' && wc != L'+' &&
        wc != L'/' && wc != L'\\' && wc != L'|' && wc != L'.' && wc != L',') {
      ++meaningful;
    }
  }
  return meaningful > 0;
}

bool utf8_to_wstring_checked(const std::string& utf8, std::wstring& out) {
  out.clear();
  if (utf8.empty()) {
    return false;
  }
  const int required = MultiByteToWideChar(
      CP_UTF8, MB_ERR_INVALID_CHARS, utf8.c_str(), -1, nullptr, 0);
  if (required <= 1) {
    return false;
  }
  out.resize(static_cast<size_t>(required - 1));
  const int converted = MultiByteToWideChar(
      CP_UTF8, MB_ERR_INVALID_CHARS, utf8.c_str(), -1, &out[0], required);
  return converted > 1;
}

bool is_likely_event_name(const char* name) {
  if (!name || !looks_like_string(name, 96)) {
    return false;
  }
  if (name[0] != '@') {
    return false;
  }
  size_t len = 0;
  for (; name[len] != '\0'; ++len) {
    unsigned char c = static_cast<unsigned char>(name[len]);
    if (len > 80) {
      return false;
    }
    if (c < 0x20 || c > 0x7E) {
      return false;
    }
    const bool ok =
        (c >= 'a' && c <= 'z') ||
        (c >= 'A' && c <= 'Z') ||
        (c >= '0' && c <= '9') ||
        c == '@' || c == '_' || c == '-' || c == '.';
    if (!ok) {
      return false;
    }
  }
  return len > 1;
}

bool is_whitelisted_olvc_name(const char* name) {
  if (!is_likely_event_name(name)) {
    return false;
  }
  if (strstr(name, "PlayState") != nullptr || strstr(name, "IsPlaying") != nullptr ||
      strcmp(name, "@Play") == 0 || strcmp(name, "@Pause") == 0 ||
      strcmp(name, "@Stop") == 0) {
    return true;
  }
  return
      strcmp(name, "@BPM") == 0 ||
      strcmp(name, "@SyncSlaveBPM") == 0 ||
      strcmp(name, "@OriginalBPM") == 0 ||
      strcmp(name, "@CurrentTime") == 0 ||
      strcmp(name, "@TotalTime") == 0 ||
      strcmp(name, "@MixPointLinkRemainingTime") == 0 ||
      strcmp(name, "@TrackBrowserID") == 0 ||
      strcmp(name, "@TrackNo") == 0;
}

// 拡張メタデータ構造体
struct TrackMetaFields {
  std::string title;
  std::string artist;
  std::string album;
  std::string genre;
  std::string label;
  std::string key;
  std::string origArtist;
  std::string remixer;
  std::string composer;
  std::string comment;
  std::string mixName;
  std::string lyricist;
  uint32_t trackBpm = 0;     // 15150 = 151.50 BPM
  uint32_t trackNumber = 0;
};

void send_track_meta_extended(int deck, const TrackMetaFields& m) {
  // JSON を動的に構築（空フィールドは省略）
  std::string payload = "{\"type\":\"track_meta\",\"deck\":";
  payload += std::to_string(deck);
  auto appendStr = [&](const char* key, const std::string& val) {
    if (val.empty()) return;
    payload += ",\"";
    payload += key;
    payload += "\":\"";
    payload += escape_json(val.c_str());
    payload += "\"";
  };
  appendStr("title", m.title);
  appendStr("artist", m.artist);
  appendStr("album", m.album);
  appendStr("genre", m.genre);
  appendStr("label", m.label);
  appendStr("key", m.key);
  appendStr("origArtist", m.origArtist);
  appendStr("remixer", m.remixer);
  appendStr("composer", m.composer);
  appendStr("comment", m.comment);
  appendStr("mixName", m.mixName);
  appendStr("lyricist", m.lyricist);
  if (m.trackBpm > 0) {
    payload += ",\"trackBpm\":";
    payload += std::to_string(static_cast<unsigned long long>(m.trackBpm));
  }
  if (m.trackNumber > 0) {
    payload += ",\"trackNumber\":";
    payload += std::to_string(static_cast<unsigned long long>(m.trackNumber));
  }
  payload += "}";
  send_packet(payload);
}

// 後方互換: 旧シグネチャの send_track_meta はそのまま維持
void send_track_meta(int deck, const std::string& title, const std::string& artist) {
  TrackMetaFields m;
  m.title = title;
  m.artist = artist;
  send_track_meta_extended(deck, m);
}

// 前方宣言
bool resolve_player_slots();
bool is_likely_track_id(uint32_t value);
uint32_t read_player_track_browser_id(uintptr_t playerPtr, bool allowFallback = false);

// RowDataTrack ポインタから全メタデータを読んで送信する共通処理
void try_send_strings_from_row_data(int deckOneBased, uintptr_t rowData) {
  if (!rowData || IsBadReadPtr(reinterpret_cast<const void*>(rowData), 0x450)) return;

  const int slot = (deckOneBased - 1) % 4;
  auto is_reserved_track_text = [](const std::string& s) -> bool {
    if (s.empty()) return true;
    static const char* kBlockedPrefixes[] = {"@", "ActivePart", "FXPart", "TrackBrowserID", "BPM"};
    for (const char* prefix : kBlockedPrefixes) {
      const size_t n = strlen(prefix);
      if (s.size() >= n && _strnicmp(s.c_str(), prefix, n) == 0) return true;
    }
    return false;
  };

  auto read_utf8_str = [&](uintptr_t offset) -> std::string {
    uintptr_t ptr = 0;
    if (!safe_read_ptr(rowData + offset, ptr)) return "";
    if (!ptr || IsBadReadPtr(reinterpret_cast<const void*>(ptr), 4)) return "";
    const char* src = reinterpret_cast<const char*>(ptr);
    if (!looks_like_string(src, 512)) return "";
    size_t rawLen = 0;
    for (; rawLen < 512 && src[rawLen] != '\0'; ++rawLen) {}
    if (rawLen == 0 || rawLen >= 511) return "";
    std::string s(src, rawLen);
    if (is_reserved_track_text(s)) return "";
    std::wstring ws;
    if (!utf8_to_wstring_checked(s, ws)) return "";
    if (!is_likely_valid_track_text(ws)) return "";
    return s;
  };

  auto read_u32_val = [&](uintptr_t offset) -> uint32_t {
    uint32_t val = 0;
    if (!safe_read_u32(rowData + offset, val)) return 0;
    return val;
  };

  // RekordBoxSongExporter 7.0.8+ 準拠オフセット
  TrackMetaFields m;
  m.title      = read_utf8_str(0x20);
  m.artist     = read_utf8_str(0xC0);
  m.album      = read_utf8_str(0xF8);
  m.genre      = read_utf8_str(0x170);
  m.label      = read_utf8_str(0x1A8);
  m.key        = read_utf8_str(0x200);
  m.origArtist = read_utf8_str(0x280);
  m.remixer    = read_utf8_str(0x2F0);
  m.composer   = read_utf8_str(0x328);
  m.comment    = read_utf8_str(0x350);
  m.mixName    = read_utf8_str(0x380);
  m.lyricist   = read_utf8_str(0x448);
  m.trackBpm   = read_u32_val(0x398);
  m.trackNumber = read_u32_val(0x340);

  if (m.title.empty()) return;
  if (m.artist == m.title) {
    m.artist.clear();
  }

  const uint32_t th = simple_hash(m.title);
  const uint32_t ah = simple_hash(m.artist);
  if (g_lastTitleHash[slot] == th && g_lastArtistHash[slot] == ah) return;

  g_lastTitleHash[slot] = th;
  g_lastArtistHash[slot] = ah;
  send_track_meta_extended(deckOneBased, m);
}

// DB instance を取得するヘルパー（RB 7.x の間接参照に対応）
uintptr_t resolve_db_instance() {
  if (!g_getInstance) return 0;
  uintptr_t instance = g_getInstance();
  if (!instance) return 0;
  // RB 7.x では getInstance の返り値が this* へのポインタの場合がある
  uintptr_t instanceMaybeThis = 0;
  if (safe_read_ptr(instance, instanceMaybeThis) && instanceMaybeThis && !IsBadReadPtr(reinterpret_cast<const void*>(instanceMaybeThis), 8)) {
    instance = instanceMaybeThis;
  }
  if (IsBadReadPtr(reinterpret_cast<const void*>(instance), 8)) return 0;
  return instance;
}

// trackId を指定して RowDataTrack を構築 → メタデータを送信
void try_lookup_and_send_track_meta(int deckOneBased, uint32_t trackId) {
  if (!g_getRowDataTrack || !is_likely_track_id(trackId)) return;
  const uintptr_t instance = resolve_db_instance();
  if (!instance) return;

  alignas(16) uint8_t rowDataBuf[0x1024] = {};
  const uintptr_t rowData = reinterpret_cast<uintptr_t>(rowDataBuf);
  if (g_initRowDataTrack) {
    g_initRowDataTrack(rowData);
  }
  g_getRowDataTrack(instance, trackId, rowData, 1, 0);
  try_send_strings_from_row_data(deckOneBased, rowData);
  if (g_destrRowDataTrack) {
    g_destrRowDataTrack(rowData);
  }
}

void poll_track_strings() {
  // db::DatabaseIF + db::RowDataTrack 経路のみを使用
  if (!g_getInstance || !g_getRowDataTrack) {
    return;
  }

  for (int deck = 0; deck < 4; ++deck) {
    uint32_t trackId = g_lastPlayerTrackId[deck];
    if (!is_likely_track_id(trackId) && resolve_player_slots()) {
      trackId = read_player_track_browser_id(g_playerSlots[deck]);
    }
    if (!is_likely_track_id(trackId)) {
      continue;
    }
    try_lookup_and_send_track_meta(deck + 1, trackId);
  }
}

void send_hello() {
  char buffer[512] = {};
  _snprintf_s(buffer, sizeof(buffer), _TRUNCATE,
              "{\"type\":\"hello\",\"version\":\"%s\",\"pid\":%lu}",
              kVersion, static_cast<unsigned long>(GetCurrentProcessId()));
  send_packet(buffer);
}

bool init_udp() {
  WSADATA wsa = {};
  if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
    return false;
  }
  g_socket = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
  if (g_socket == INVALID_SOCKET) {
    return false;
  }
  g_destination.sin_family = AF_INET;
  g_destination.sin_port = htons(kUdpPort);
  g_destination.sin_addr.s_addr = inet_addr(kUdpHost);
  return true;
}

void cleanup_udp() {
  if (g_socket != INVALID_SOCKET) {
    closesocket(g_socket);
    g_socket = INVALID_SOCKET;
  }
  WSACleanup();
}

std::vector<int> parse_signature(const char* signature) {
  std::vector<int> result;
  if (!signature) {
    return result;
  }
  const char* p = signature;
  while (*p) {
    while (*p == ' ') {
      ++p;
    }
    if (!*p) {
      break;
    }
    if (*p == '?') {
      result.push_back(-1);
      while (*p && *p != ' ') {
        ++p;
      }
      continue;
    }
    unsigned int value = 0;
    if (sscanf_s(p, "%2x", &value) != 1) {
      break;
    }
    result.push_back(static_cast<int>(value & 0xFF));
    while (*p && *p != ' ') {
      ++p;
    }
  }
  return result;
}

uintptr_t scan_module_text_section(HMODULE module, const std::vector<int>& pattern) {
  if (!module || pattern.empty()) {
    return 0;
  }

  auto* dos = reinterpret_cast<PIMAGE_DOS_HEADER>(module);
  if (dos->e_magic != IMAGE_DOS_SIGNATURE) {
    return 0;
  }

  auto* nt = reinterpret_cast<PIMAGE_NT_HEADERS>(
      reinterpret_cast<uint8_t*>(module) + dos->e_lfanew);
  if (nt->Signature != IMAGE_NT_SIGNATURE) {
    return 0;
  }

  auto* section = IMAGE_FIRST_SECTION(nt);
  for (unsigned int i = 0; i < nt->FileHeader.NumberOfSections; ++i, ++section) {
    if (strncmp(reinterpret_cast<const char*>(section->Name), ".text", 5) != 0) {
      continue;
    }

    auto* start = reinterpret_cast<uint8_t*>(module) + section->VirtualAddress;
    const size_t size = static_cast<size_t>(section->Misc.VirtualSize);
    if (size < pattern.size()) {
      continue;
    }

    for (size_t offset = 0; offset <= size - pattern.size(); ++offset) {
      bool matched = true;
      for (size_t j = 0; j < pattern.size(); ++j) {
        const int sigByte = pattern[j];
        if (sigByte >= 0 && start[offset + j] != static_cast<uint8_t>(sigByte)) {
          matched = false;
          break;
        }
      }
      if (matched) {
        return reinterpret_cast<uintptr_t>(start + offset);
      }
    }
  }

  return 0;
}

uintptr_t find_get_instance() {
  HMODULE module = GetModuleHandleA(nullptr);
  const auto sig = parse_signature(kGetInstanceSig);
  return scan_module_text_section(module, sig);
}

// .text セクション先頭・サイズを取得するヘルパー
static void get_text_section(HMODULE module, uint8_t*& outStart, size_t& outSize) {
  outStart = nullptr;
  outSize = 0;
  auto* dos = reinterpret_cast<PIMAGE_DOS_HEADER>(module);
  if (dos->e_magic != IMAGE_DOS_SIGNATURE) return;
  auto* nt = reinterpret_cast<PIMAGE_NT_HEADERS>(
      reinterpret_cast<uint8_t*>(module) + dos->e_lfanew);
  if (nt->Signature != IMAGE_NT_SIGNATURE) return;
  auto* sec = IMAGE_FIRST_SECTION(nt);
  for (unsigned i = 0; i < nt->FileHeader.NumberOfSections; ++i, ++sec) {
    if (strncmp(reinterpret_cast<const char*>(sec->Name), ".text", 5) == 0) {
      outStart = reinterpret_cast<uint8_t*>(module) + sec->VirtualAddress;
      outSize = sec->Misc.VirtualSize;
      return;
    }
  }
}

// 「getInstance() を呼んだ直後に呼ばれる関数」を集計し最多のものを返す。
// これにより getRowDataTrack のシグネチャが変わっても確実に特定できる。
uintptr_t find_get_row_data_track_via_callsite() {
  if (!g_getInstance) return 0;
  HMODULE module = GetModuleHandleA(nullptr);
  uint8_t* textStart = nullptr;
  size_t textSize = 0;
  get_text_section(module, textStart, textSize);
  if (!textStart || textSize < 10) return 0;

  const uintptr_t instanceAddr = reinterpret_cast<uintptr_t>(g_getInstance);
  std::unordered_map<uintptr_t, int> callCounts;

  for (size_t i = 0; i + 5 <= textSize; ++i) {
    if (textStart[i] != 0xE8) continue;  // E8 = near call
    int32_t rel = 0;
    memcpy(&rel, textStart + i + 1, 4);
    const uintptr_t target = reinterpret_cast<uintptr_t>(textStart + i + 5) +
                              static_cast<int64_t>(rel);
    if (target != instanceAddr) continue;

    // getInstance 呼び出しを発見。次の direct call を探す (最大 120 バイト先まで)
    const size_t limit = (i + 120 < textSize) ? i + 120 : textSize - 5;
    for (size_t j = i + 5; j + 5 <= limit; ++j) {
      if (textStart[j] != 0xE8) continue;
      int32_t rel2 = 0;
      memcpy(&rel2, textStart + j + 1, 4);
      const uintptr_t next = reinterpret_cast<uintptr_t>(textStart + j + 5) +
                              static_cast<int64_t>(rel2);
      // getInstance 自身や .text 外は除外
      if (next == instanceAddr) continue;
      if (next < reinterpret_cast<uintptr_t>(textStart)) continue;
      if (next >= reinterpret_cast<uintptr_t>(textStart) + textSize) continue;
      callCounts[next]++;
      break;
    }
  }

  // 最も多く「getInstanceの直後に呼ばれた」関数を getRowDataTrack とみなす
  uintptr_t best = 0;
  int bestCount = 0;
  for (auto& kv : callCounts) {
    if (kv.second > bestCount) {
      bestCount = kv.second;
      best = kv.first;
    }
  }
  return (bestCount >= 2) ? best : 0;
}

uintptr_t find_get_row_data_track() {
  HMODULE module = GetModuleHandleA(nullptr);
  // まずシグネチャスキャン（ワイルドカード版）
  const auto sig = parse_signature(kGetRowDataTrackSig);
  uintptr_t addr = scan_module_text_section(module, sig);
  if (addr) return addr;
  // 失敗したらコールサイト解析で特定
  return find_get_row_data_track_via_callsite();
}

uintptr_t find_init_row_data_track() {
  HMODULE module = GetModuleHandleA(nullptr);
  const auto sig = parse_signature(kInitRowDataTrackSig);
  return scan_module_text_section(module, sig);
}

uintptr_t find_destr_row_data_track() {
  HMODULE module = GetModuleHandleA(nullptr);
  const auto sig = parse_signature(kDestrRowDataTrackSig);
  return scan_module_text_section(module, sig);
}

uintptr_t find_olvc_target() {
  HMODULE module = GetModuleHandleA(nullptr);
  const auto primary = parse_signature(kOlvcSigPrimary);
  uintptr_t address = scan_module_text_section(module, primary);
  if (address) {
    return address;
  }
  const auto fallback = parse_signature(kOlvcSigFallback);
  return scan_module_text_section(module, fallback);
}

uintptr_t find_load_file_target() {
  HMODULE module = GetModuleHandleA(nullptr);
  const auto sig708 = parse_signature(kLoadFileSig708);
  uintptr_t address = scan_module_text_section(module, sig708);
  if (address) {
    return address;
  }
  const auto sig670 = parse_signature(kLoadFileSig670);
  return scan_module_text_section(module, sig670);
}

bool resolve_player_slots() {
  if (g_playerSlotsTried) {
    return g_playerSlotsResolved;
  }
  g_playerSlotsTried = true;

  HMODULE module = GetModuleHandleA(nullptr);
  const auto pattern = parse_signature(kMainComponentSig7);
  const uintptr_t mainComponentRef = scan_module_text_section(module, pattern);
  if (!mainComponentRef) {
    return false;
  }

  int32_t rel = 0;
  if (!safe_read_i32(mainComponentRef + 0x4A, rel)) {
    return false;
  }
  const uintptr_t mainComponentAddr = mainComponentRef + 0x4E + static_cast<int64_t>(rel);

  uintptr_t mainComponent = 0;
  if (!safe_read_ptr(mainComponentAddr, mainComponent) || !mainComponent) {
    return false;
  }

  uintptr_t uiManager = 0;
  if (!safe_read_ptr(mainComponent + 0x490, uiManager) || !uiManager) {
    return false;
  }

  int resolved = 0;
  for (int i = 0; i < 4; ++i) {
    uintptr_t player = 0;
    if (safe_read_ptr(uiManager + 0x50 + static_cast<uintptr_t>(i) * sizeof(uintptr_t), player) &&
        player != 0) {
      g_playerSlots[i] = player;
      ++resolved;
    }
  }

  g_playerSlotsResolved = resolved > 0;
  return g_playerSlotsResolved;
}

int lookup_deck_from_player(uintptr_t playerPtr) {
  if (!playerPtr) {
    return -1;
  }
  if (!resolve_player_slots()) {
    return -1;
  }
  for (int i = 0; i < 4; ++i) {
    if (g_playerSlots[i] == playerPtr) {
      return i;
    }
  }
  return -1;
}

bool is_likely_track_id(uint32_t value) {
  return value >= 1000000 && value < 500000000;
}

uint32_t extract_track_id_from_olvc_value(uintptr_t rawValue) {
  const uint32_t low32 = static_cast<uint32_t>(rawValue & 0xFFFFFFFFULL);
  if (is_likely_track_id(low32)) {
    return low32;
  }
  static const uintptr_t kPointerOffsets[] = {0x0, 0x4, 0x8, 0x10, 0x18, 0x20};
  for (uintptr_t off : kPointerOffsets) {
    uint32_t candidate = 0;
    if (!safe_read_u32(rawValue + off, candidate)) {
      continue;
    }
    if (is_likely_track_id(candidate)) {
      return candidate;
    }
  }
  return 0;
}

uint32_t read_player_track_browser_id(uintptr_t playerPtr, bool allowFallback) {
  if (!playerPtr) {
    return 0;
  }
  static const uintptr_t kTrackIdOffsets[] = {0x580, 0x57C, 0x584, 0x578, 0x588};
  for (uintptr_t offset : kTrackIdOffsets) {
    uint32_t value = 0;
    if (!safe_read_u32(playerPtr + offset, value)) {
      continue;
    }
    if (is_likely_track_id(value)) {
      return value;
    }
  }

  if (!allowFallback) {
    return 0;
  }

  std::unordered_map<uint32_t, int> counts;
  static const uintptr_t kScanStart = 0x100;
  static const uintptr_t kScanEnd = 0x900;
  for (uintptr_t offset = kScanStart; offset <= kScanEnd; offset += sizeof(uint32_t)) {
    uint32_t value = 0;
    if (!safe_read_u32(playerPtr + offset, value)) {
      continue;
    }
    if (!is_likely_track_id(value)) {
      continue;
    }
    counts[value] += 1;
  }
  uint32_t best = 0;
  int bestCount = 0;
  for (const auto& kv : counts) {
    if (kv.second > bestCount) {
      best = kv.first;
      bestCount = kv.second;
    }
  }
  if (bestCount >= 4) {
    return best;
  }

  return 0;
}

uint32_t read_loadinfo_track_browser_id(uintptr_t loadInfoPtr) {
  if (!loadInfoPtr) {
    return 0;
  }
  // RekordBoxSongExporter 7.x 相当: +0x20 付近
  static const uintptr_t kLoadInfoOffsets[] = {0x20, 0x18, 0x10, 0x08, 0x28};
  for (uintptr_t offset : kLoadInfoOffsets) {
    uint32_t value = 0;
    if (!safe_read_u32(loadInfoPtr + offset, value)) {
      continue;
    }
    if (is_likely_track_id(value)) {
      return value;
    }
  }
  return 0;
}

void poll_player_track_ids() {
  if (!resolve_player_slots()) {
    return;
  }
  const ULONGLONG nowTick = static_cast<ULONGLONG>(GetTickCount());
  for (int i = 0; i < 4; ++i) {
    const uintptr_t player = g_playerSlots[i];
    if (!player) {
      continue;
    }
    if (nowTick >= g_lastProbeTick[i] + 5000) {
      g_lastProbeTick[i] = nowTick;
      auto cidCandidates = probe_content_id_candidates(player);
      if (!cidCandidates.empty()) {
        send_cid_probe(i + 1, cidCandidates);
      }
    }
    if (nowTick <= g_lastPlayerProbeTick[i] + 1500) {
      continue;
    }
    g_lastPlayerProbeTick[i] = nowTick;

    // allowFallback=true: already-loaded tracks (pre-injection) require the
    // wider memory scan. Cross-deck bleed is prevented at the app.js layer.
    const uint32_t directTrackId = read_player_track_browser_id(player, true);
    if (!is_likely_track_id(directTrackId)) {
      if (g_trackIdMisses[i] < 0xFFFFFFFFu) {
        ++g_trackIdMisses[i];
      }
      continue;
    }
    if (g_trackIdHits[i] < 0xFFFFFFFFu) {
      ++g_trackIdHits[i];
    }
    const uint32_t primary = directTrackId;
    if (g_lastPlayerPrimaryCandidate[i] != primary) {
      g_lastPlayerPrimaryCandidate[i] = primary;
      send_track_load_log(i + 1, primary);
    }
    if (g_lastPlayerStableCandidate[i] == primary) {
      if (g_lastPlayerStableHits[i] < 255) {
        ++g_lastPlayerStableHits[i];
      }
    } else {
      g_lastPlayerStableCandidate[i] = primary;
      g_lastPlayerStableHits[i] = 1;
    }
    if (g_lastPlayerStableHits[i] >= 2 && g_lastPlayerTrackId[i] != primary) {
      g_lastPlayerTrackId[i] = primary;
      send_track_load(i + 1, primary, player, 0, 0);
    }
  }
  if (nowTick >= g_lastTrackDiagLogTick + 10000) {
    g_lastTrackDiagLogTick = nowTick;
    char diag[512] = {};
    _snprintf_s(
        diag, sizeof(diag), _TRUNCATE,
        "{\"type\":\"log\",\"message\":\"track-id diag d1=%llu(h=%llu,m=%llu) d2=%llu(h=%llu,m=%llu)\"}",
        static_cast<unsigned long long>(g_lastPlayerTrackId[0]),
        static_cast<unsigned long long>(g_trackIdHits[0]),
        static_cast<unsigned long long>(g_trackIdMisses[0]),
        static_cast<unsigned long long>(g_lastPlayerTrackId[1]),
        static_cast<unsigned long long>(g_trackIdHits[1]),
        static_cast<unsigned long long>(g_trackIdMisses[1]));
    send_packet(diag);
  }
}

uintptr_t __fastcall olvc_detour(uintptr_t arg1, uintptr_t arg2, uintptr_t arg3, uintptr_t arg4) {
  const char* name = nullptr;
  if (arg3) {
    name = *reinterpret_cast<const char**>(arg3);
  }

  if (name != nullptr &&
      (strcmp(name, "@TrackBrowserID") == 0 || strstr(name, "TrackBrowserID") != nullptr ||
       strstr(name, "ContentID") != nullptr)) {
    const uint32_t contentId = extract_track_id_from_olvc_value(arg4);
    if (is_likely_track_id(contentId)) {
      int deckRaw = static_cast<int>(arg2);
      if (deckRaw <= 0) {
        deckRaw = 1;
      }
      const int slot = (deckRaw - 1) % 4;
      if (slot >= 0 && slot < 4 && g_lastPlayerTrackId[slot] != contentId) {
        g_lastPlayerTrackId[slot] = contentId;
        send_track_load(deckRaw, contentId, arg1, arg3, arg4);
        send_track_load_log(deckRaw, contentId);
      }
    }
  }

  if (is_whitelisted_olvc_name(name)) {
    char packet[512] = {};
    _snprintf_s(packet, sizeof(packet), _TRUNCATE,
                "{\"type\":\"olvc\",\"deck\":%llu,\"name\":\"%s\",\"value\":%llu}",
                static_cast<unsigned long long>(arg2),
                escape_json(name).c_str(),
                static_cast<unsigned long long>(arg4));
    send_packet(packet);
  }

  if (g_originalOlvc) {
    return g_originalOlvc(arg1, arg2, arg3, arg4);
  }
  return 0;
}

uintptr_t __fastcall load_file_detour(uintptr_t arg1, uintptr_t arg2, uintptr_t arg3, uintptr_t arg4) {
  if (g_loadDetourHits < 0xFFFFFFFFu) {
    ++g_loadDetourHits;
  }
  const ULONGLONG nowTick = static_cast<ULONGLONG>(GetTickCount());
  if (nowTick >= g_lastLoadDetourLogTick + 5000) {
    g_lastLoadDetourLogTick = nowTick;
    char loadDiag[256] = {};
    _snprintf_s(loadDiag, sizeof(loadDiag), _TRUNCATE,
                "{\"type\":\"log\",\"message\":\"load_file_detour hits=%llu\"}",
                static_cast<unsigned long long>(g_loadDetourHits));
    send_packet(loadDiag);
  }
  const int deckIndex = lookup_deck_from_player(arg1);
  int deckRaw = deckIndex >= 0 ? deckIndex + 1 : 0;
  if (deckRaw <= 0 && arg3 >= 1 && arg3 <= 4) {
    deckRaw = static_cast<int>(arg3);
  } else if (deckRaw <= 0 && arg4 >= 1 && arg4 <= 4) {
    deckRaw = static_cast<int>(arg4);
  }

  uint32_t loadTrackId = read_loadinfo_track_browser_id(arg2);
  if (!is_likely_track_id(loadTrackId)) {
    loadTrackId = read_player_track_browser_id(arg1, true);
  }
  if (deckRaw > 0) {
    const auto candidates = probe_loadinfo_candidates(arg2);
    if (!candidates.empty()) {
      send_cid_probe(deckRaw, candidates);
    }
  }
  if (is_likely_track_id(loadTrackId)) {
    send_track_load(deckRaw, loadTrackId, arg1, arg3, arg4);
    send_track_load_log(deckRaw, loadTrackId);
    if (deckRaw > 0) {
      const int slot = (deckRaw - 1) % 4;
      if (slot >= 0 && slot < 4) {
        g_lastPlayerTrackId[slot] = loadTrackId;
        g_lastPlayerStableCandidate[slot] = loadTrackId;
        g_lastPlayerStableHits[slot] = 2;
        // イベント駆動: 曲ロード時に即座に RowDataTrack でメタデータ取得
        g_lastTitleHash[slot] = 0;
        g_lastArtistHash[slot] = 0;
        try_lookup_and_send_track_meta(deckRaw, loadTrackId);
      }
    }
  }

  if (g_originalLoadFile) {
    const uintptr_t result = g_originalLoadFile(arg1, arg2, arg3, arg4);
    return result;
  }
  return 0;
}

uintptr_t __fastcall notify_master_change_detour(uintptr_t arg1, uintptr_t arg2, uintptr_t arg3, uintptr_t arg4) {
  // arg2 はマスターデッキインデックス (0-based)
  int deckRaw = static_cast<int>(arg2) + 1;
  if (deckRaw < 1 || deckRaw > 4) {
    deckRaw = static_cast<int>(arg2);
  }
  char buf[256] = {};
  _snprintf_s(buf, sizeof(buf), _TRUNCATE,
              "{\"type\":\"master_change\",\"deck\":%d,\"arg1\":%llu,\"arg2\":%llu}",
              deckRaw,
              static_cast<unsigned long long>(arg1),
              static_cast<unsigned long long>(arg2));
  send_packet(buf);

  if (g_originalNotifyMasterChange) {
    return g_originalNotifyMasterChange(arg1, arg2, arg3, arg4);
  }
  return 0;
}

uintptr_t find_notify_master_change_target() {
  HMODULE module = GetModuleHandleA(nullptr);
  const auto sig708 = parse_signature(kNotifyMasterChangeSig708);
  uintptr_t address = scan_module_text_section(module, sig708);
  if (address) return address;
  const auto sigFallback = parse_signature(kNotifyMasterChangeSigFallback);
  return scan_module_text_section(module, sigFallback);
}

DWORD WINAPI worker_thread(LPVOID) {
  if (!init_udp()) {
    return 0;
  }

  send_hello();

  if (MH_Initialize() != MH_OK) {
    send_error("MH_Initialize failed");
    return 0;
  }

  const uintptr_t target = find_olvc_target();
  if (!target) {
    send_error("OLVC signature not found in rekordbox.exe");
    return 0;
  }

  if (MH_CreateHook(reinterpret_cast<LPVOID>(target), reinterpret_cast<LPVOID>(&olvc_detour),
                    reinterpret_cast<LPVOID*>(&g_originalOlvc)) != MH_OK) {
    send_error("MH_CreateHook failed");
    return 0;
  }
  if (MH_EnableHook(reinterpret_cast<LPVOID>(target)) != MH_OK) {
    send_error("MH_EnableHook failed");
    return 0;
  }

  g_olvcHookInstalled = true;
  send_packet("{\"type\":\"log\",\"message\":\"OLVC hook installed\"}");

  const uintptr_t loadTarget = find_load_file_target();
  if (!loadTarget) {
    send_packet("{\"type\":\"log\",\"message\":\"LoadFile signature not found\"}");
  } else if (
      MH_CreateHook(reinterpret_cast<LPVOID>(loadTarget), reinterpret_cast<LPVOID>(&load_file_detour),
                    reinterpret_cast<LPVOID*>(&g_originalLoadFile)) != MH_OK) {
    send_packet("{\"type\":\"log\",\"message\":\"LoadFile hook create failed\"}");
  } else if (MH_EnableHook(reinterpret_cast<LPVOID>(loadTarget)) != MH_OK) {
    send_packet("{\"type\":\"log\",\"message\":\"LoadFile hook enable failed\"}");
  } else {
    g_loadFileHookInstalled = true;
    send_packet("{\"type\":\"log\",\"message\":\"LoadFile hook installed\"}");
  }

  // notifyMasterChange フック (best-effort: 見つからなくても動作に影響しない)
  const uintptr_t masterChangeTarget = find_notify_master_change_target();
  if (!masterChangeTarget) {
    send_packet("{\"type\":\"log\",\"message\":\"NotifyMasterChange signature not found (non-critical)\"}");
  } else if (
      MH_CreateHook(reinterpret_cast<LPVOID>(masterChangeTarget), reinterpret_cast<LPVOID>(&notify_master_change_detour),
                    reinterpret_cast<LPVOID*>(&g_originalNotifyMasterChange)) != MH_OK) {
    send_packet("{\"type\":\"log\",\"message\":\"NotifyMasterChange hook create failed\"}");
  } else if (MH_EnableHook(reinterpret_cast<LPVOID>(masterChangeTarget)) != MH_OK) {
    send_packet("{\"type\":\"log\",\"message\":\"NotifyMasterChange hook enable failed\"}");
  } else {
    g_masterChangeHookInstalled = true;
    send_packet("{\"type\":\"log\",\"message\":\"NotifyMasterChange hook installed\"}");
  }

  const uintptr_t getInstanceAddr = find_get_instance();
  if (getInstanceAddr) {
    g_getInstance = reinterpret_cast<GetInstanceFn>(getInstanceAddr);
    send_packet("{\"type\":\"log\",\"message\":\"getInstance found\"}");
  } else {
    send_packet("{\"type\":\"log\",\"message\":\"getInstance signature not found\"}");
  }

  const uintptr_t getRowDataTrackAddr = find_get_row_data_track();
  if (getRowDataTrackAddr) {
    g_getRowDataTrack = reinterpret_cast<GetRowDataTrackFn>(getRowDataTrackAddr);
    send_packet("{\"type\":\"log\",\"message\":\"getRowDataTrack found\"}");
  } else {
    send_packet("{\"type\":\"log\",\"message\":\"getRowDataTrack signature not found\"}");
  }

  const uintptr_t initRowDataTrackAddr = find_init_row_data_track();
  if (initRowDataTrackAddr) {
    g_initRowDataTrack = reinterpret_cast<InitRowDataTrackFn>(initRowDataTrackAddr);
    send_packet("{\"type\":\"log\",\"message\":\"initRowDataTrack found\"}");
  } else {
    send_packet("{\"type\":\"log\",\"message\":\"initRowDataTrack signature not found\"}");
  }

  const uintptr_t destrRowDataTrackAddr = find_destr_row_data_track();
  if (destrRowDataTrackAddr) {
    g_destrRowDataTrack = reinterpret_cast<DestrRowDataTrackFn>(destrRowDataTrackAddr);
    send_packet("{\"type\":\"log\",\"message\":\"destrRowDataTrack found\"}");
  } else {
    send_packet("{\"type\":\"log\",\"message\":\"destrRowDataTrack signature not found\"}");
  }

  if (g_getInstance && g_getRowDataTrack) {
    if (!g_initRowDataTrack || !g_destrRowDataTrack) {
      send_packet(
          "{\"type\":\"log\",\"message\":\"RowData path active with partial lifecycle functions\"}");
    } else {
      send_packet("{\"type\":\"log\",\"message\":\"RowData path active\"}");
    }
  }

  while (true) {
    poll_player_track_ids();
    Sleep(1000);
  }
}

}  // namespace

BOOL APIENTRY DllMain(HMODULE module, DWORD reason, LPVOID) {
  if (reason == DLL_PROCESS_ATTACH) {
    DisableThreadLibraryCalls(module);
    HANDLE thread = CreateThread(nullptr, 0, worker_thread, nullptr, 0, nullptr);
    if (thread) {
      CloseHandle(thread);
    }
  } else if (reason == DLL_PROCESS_DETACH) {
    if (g_olvcHookInstalled || g_loadFileHookInstalled || g_masterChangeHookInstalled) {
      MH_DisableHook(MH_ALL_HOOKS);
      MH_Uninitialize();
      g_olvcHookInstalled = false;
      g_loadFileHookInstalled = false;
      g_masterChangeHookInstalled = false;
    }
    cleanup_udp();
  }
  return TRUE;
}
