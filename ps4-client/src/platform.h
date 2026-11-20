#pragma once
#include <cstdint>
#include <string>

namespace platform {

bool jailbreak();

bool loadModule(const char* path);

void* resolveSymbol(const char* modulePath, const char* symbol);

bool getForegroundTitleId(std::string& out);

bool initNetwork();

int httpContextId();

void bootLog(const char* msg);
void bootLogf(const char* fmt, ...) __attribute__((format(printf, 1, 2)));

void installCrashHandlers();

void setCrashHook(void (*hook)());

void logCaught(const char* where);

int loadSystemModules();
bool initImeDialog();

const std::string& lastError();
void setLastError(const std::string& msg);

enum class SystemEvent { None, Pause, Resume, Other };

SystemEvent pollSystemEvent(uint32_t* rawType = nullptr);

bool inBackground();

std::string systemLanguage();

bool getFreeDiskSpaceBytes(uint64_t& freeBytes, uint64_t* totalBytes = nullptr);
int clearDirectory(const std::string& dir);

bool makeDirs(const std::string& path);
bool fileExists(const std::string& path);

}
