#pragma once
#include <string>

namespace config {

constexpr const char* DEFAULT_SERVER_URL = "http://192.168.1.100:3000";

constexpr const char* DATA_DIR  = "/data/PS4Store";
constexpr const char* CACHE_DIR = "/data/PS4Store/cache";

std::string loadServerUrl();

std::string videoMode();

}
