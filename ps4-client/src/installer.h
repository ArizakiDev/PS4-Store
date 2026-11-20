#pragma once
#include <cstdint>
#include <string>

namespace installer {

struct PkgHeader {
    std::string contentId;
    const char* type = "";
    uint32_t flags = 0;
    uint64_t size = 0;
};

constexpr int HEADER_BYTES = 4096;

bool parseHeader(const std::string& header, PkgHeader& out, std::string& err);

std::string bgftUrl(const std::string& url, const std::string& contentId);

bool init(std::string& err);
void shutdown();

bool registerAndStart(const PkgHeader& hdr, const std::string& url, const std::string& name,
                      const std::string& iconPath, int& taskId, std::string& err);

bool installLocalPkg(const std::string& path, std::string& err);

struct Progress {
    uint64_t length = 0, transferred = 0;
    int error = 0;
    int preparingPercent = 0;
};
bool progress(int taskId, Progress& out);
void stopTask(int taskId);

}
