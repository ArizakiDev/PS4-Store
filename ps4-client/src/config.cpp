#include "config.h"

#include "json.h"
#include "platform.h"

#include <cstdio>
#include <fstream>
#include <sstream>

namespace config {

static std::string trimSlash(std::string s) {
    while (!s.empty() && (s.back() == '/' || s.back() == ' ' || s.back() == '\n' || s.back() == '\r')) s.pop_back();
    return s;
}

std::string loadServerUrl() {
    platform::makeDirs(DATA_DIR);
    platform::makeDirs(CACHE_DIR);

    const std::string file = std::string(DATA_DIR) + "/config.json";
    std::ifstream in(file, std::ios::binary);
    if (in) {
        std::stringstream ss;
        ss << in.rdbuf();
        json::Object obj;
        if (json::parseObject(ss.str(), obj)) {
            auto it = obj.find("server_url");
            if (it != obj.end() && !it->second.empty()) return trimSlash(it->second);
        }
        return trimSlash(DEFAULT_SERVER_URL);
    }

    std::ofstream out(file, std::ios::binary | std::ios::trunc);
    if (out) out << "{\n  \"server_url\": \"" << json::escape(DEFAULT_SERVER_URL) << "\",\n  \"video_mode\": \"1080p\"\n}\n";
    return trimSlash(DEFAULT_SERVER_URL);
}

std::string videoMode() {
    std::ifstream in(std::string(DATA_DIR) + "/config.json", std::ios::binary);
    if (!in) return "1080p";
    std::stringstream ss;
    ss << in.rdbuf();
    json::Object obj;
    if (!json::parseObject(ss.str(), obj)) return "1080p";
    auto it = obj.find("video_mode");
    if (it == obj.end()) return "1080p";
    std::string v;
    for (char c : it->second) v += (char)((c >= 'A' && c <= 'Z') ? c + 32 : c);
    return (v == "720p" || v == "720") ? "720p" : "1080p";
}

}
