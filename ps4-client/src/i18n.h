#pragma once
#include <initializer_list>
#include <string>
#include <utility>

namespace i18n {

constexpr int COUNT = 3;
extern const char* const kCodes[COUNT];
extern const char* const kNames[COUNT];

int readAll();
void init();

int index();
void setIndex(int i);
int indexOf(const std::string& code);

const std::string& tr(const std::string& key);
std::string tr(const std::string& key, std::initializer_list<std::pair<const char*, std::string>> vars);

}
