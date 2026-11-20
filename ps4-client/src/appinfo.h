#pragma once
#if defined(__has_include)
#  if __has_include("ps4store_version.h")
#    include "ps4store_version.h"
#  endif
#endif
#ifndef APP_VERSION
#define APP_VERSION "00.00"
#endif
#ifdef APP_VERSION_STR
constexpr bool appVersionEquals(const char* a, const char* b) {
    while (*a && *b) { if (*a++ != *b++) return false; }
    return *a == *b;
}
static_assert(appVersionEquals(APP_VERSION, APP_VERSION_STR), "APP_VERSION (build/gen/ps4store_version.h) differe de -DAPP_VERSION_STR (build.bat)");
#endif
#ifndef APP_TITLE_ID
#define APP_TITLE_ID "PSTR00001"
#endif

constexpr const char* kSelfUpdateId = "__self_update__";
