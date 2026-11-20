#pragma once
#include <map>
#include <string>
#include <vector>

namespace json {

using Object = std::map<std::string, std::string>;

bool parseObjectArray(const std::string& text, std::vector<Object>& out);

bool parseObject(const std::string& text, Object& out);

std::string rawField(const std::string& text, const std::string& key);
std::vector<std::string> stringArrayField(const std::string& text, const std::string& key);
bool objectArrayField(const std::string& text, const std::string& key, std::vector<Object>& out);

std::string escape(const std::string& s);

}
