#pragma once
#include <atomic>
#include <cstdint>
#include <functional>
#include <string>

namespace http {

void globalInit();
void globalCleanup();

long get(const std::string& url, std::string& body, std::string& err, long timeoutSec = 20);

bool getHead(const std::string& url, int count, std::string& body, bool& partial, std::string& err);

long downloadToFile(const std::string& url, const std::string& path, uint64_t& total,
                    const std::function<void(uint64_t, uint64_t)>& progress, const std::atomic<bool>* cancel, std::string& err);

long request(const std::string& method, const std::string& url, const std::string& bearer, const std::string& body,
             std::string& respBody, std::string& err, long timeoutSec = 15);

void setSuspended(bool on);
bool suspended();
void abortAll();

}
