#include "i18n.h"

#include "json.h"
#include "platform.h"
#include "text.h"

#include <vector>

namespace i18n {

const char* const kCodes[COUNT] = {"fr", "en", "es"};
const char* const kNames[COUNT] = {"Fran\xC3\xA7" "ais", "English", "Espa\xC3\xB1" "ol"};

namespace {
json::Object g_dict[COUNT];
std::string g_text[COUNT];
bool g_have[COUNT] = {};
int g_index = 0;
std::string g_missing;

bool readLocale(int i, std::string& out) {
    std::vector<unsigned char> b;
    const std::string code = kCodes[i];
    const std::string paths[] = {"/app0/assets/misc/" + code + ".json", "assets/misc/" + code + ".json", "assets/locales/" + code + ".json",
                                 "/data/PS4Store/locales/" + code + ".json"};
    for (const std::string& p : paths)
        if (TextRenderer::readFile(p, b)) { out.assign(b.begin(), b.end()); return true; }
    return false;
}
}

int readAll() {
    int n = 0;
    for (int i = 0; i < COUNT; ++i) {
        g_have[i] = readLocale(i, g_text[i]);
        if (g_have[i]) ++n;
        platform::bootLogf("i18n: %s.json %s", kCodes[i], g_have[i] ? "lu" : "INTROUVABLE");
    }
    return n;
}

void init() {
    for (int i = 0; i < COUNT; ++i) {
        g_dict[i].clear();
        if (!g_have[i] && !(g_have[i] = readLocale(i, g_text[i]))) continue;
        if (!json::parseObject(g_text[i], g_dict[i])) { g_dict[i].clear(); platform::bootLogf("i18n: %s.json invalide", kCodes[i]); }
        g_text[i].clear();
        g_text[i].shrink_to_fit();
    }
}

int index() { return g_index; }
void setIndex(int i) { g_index = (i % COUNT + COUNT) % COUNT; }
int indexOf(const std::string& code) {
    for (int i = 0; i < COUNT; ++i) if (code == kCodes[i]) return i;
    return -1;
}

const std::string& tr(const std::string& key) {
    auto it = g_dict[g_index].find(key);
    if (it != g_dict[g_index].end() && !it->second.empty()) return it->second;
    it = g_dict[0].find(key);
    if (it != g_dict[0].end() && !it->second.empty()) return it->second;
    g_missing = key;
    return g_missing;
}

std::string tr(const std::string& key, std::initializer_list<std::pair<const char*, std::string>> vars) {
    std::string s = tr(key);
    for (const auto& v : vars) {
        const std::string tag = std::string("{") + v.first + "}";
        for (size_t p = s.find(tag); p != std::string::npos; p = s.find(tag, p + v.second.size())) s.replace(p, tag.size(), v.second);
    }
    return s;
}

}
