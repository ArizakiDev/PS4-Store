#include "settings.h"

#include "config.h"
#include "json.h"
#include "platform.h"
#include "text.h"

#include <cstdio>
#include <vector>

namespace settings {

namespace {
const char* kPath = "/data/PS4Store/settings.json";

const Palette kPalettes[THEMES] = {
    {"ps4", {255, 255, 255, 255}, {150, 170, 200, 255}, {0, 112, 209, 255}, {96, 160, 230, 255}, {44, 84, 138, 255}, {14, 30, 60, 255},
     {206, 216, 232, 255}, {6, 14, 32, 255}, {6, 14, 32, 14, 38, 82, 10, 28, 62}},
    {"noir", {240, 240, 240, 255}, {136, 139, 146, 255}, {58, 110, 190, 255}, {132, 160, 208, 255}, {52, 54, 60, 255}, {22, 23, 26, 255},
     {206, 208, 213, 255}, {0, 0, 0, 255}, {0, 0, 0, 10, 10, 12, 4, 4, 6}},
    {"graphite", {236, 238, 240, 255}, {140, 147, 153, 255}, {47, 143, 131, 255}, {110, 180, 170, 255}, {60, 66, 72, 255}, {30, 34, 38, 255},
     {208, 212, 216, 255}, {16, 18, 21, 255}, {22, 25, 29, 36, 41, 47, 28, 32, 37}},
    {"clair", {28, 30, 36, 255}, {98, 106, 122, 255}, {0, 112, 209, 255}, {0, 96, 186, 255}, {200, 206, 218, 255}, {248, 249, 251, 255},
     {52, 58, 72, 255}, {232, 235, 241, 255}, {240, 242, 247, 228, 233, 242, 234, 238, 245}},
};
}

const Palette& palette(int theme) { return kPalettes[(theme % THEMES + THEMES) % THEMES]; }

Values load() {
    Values v;
    std::vector<unsigned char> b;
    if (!TextRenderer::readFile(kPath, b)) return v;
    json::Object o;
    if (!json::parseObject(std::string(b.begin(), b.end()), o)) { platform::bootLog("settings: fichier illisible, valeurs par defaut"); return v; }
    const std::string t = o["theme"];
    for (int i = 0; i < THEMES; ++i) if (t == kPalettes[i].id) v.theme = i;
    if (t == "classic") v.theme = 0; else if (t == "oled") v.theme = 1; else if (t == "midnight") v.theme = 2; else if (t == "light") v.theme = 3;
    const std::string sv = o["sort"];
    if (sv.size() == 1 && sv[0] >= '0' && sv[0] <= '3') v.sort = sv[0] - '0';
    const std::string l = o["lang"];
    if (l == "fr" || l == "en" || l == "es") v.lang = l;
    const std::string tok = o["device_token"];
    bool hex = tok.size() == 64;
    for (char c : tok) if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))) hex = false;
    if (hex) { v.device_token = tok; v.paired_username = o["paired_username"]; }
    return v;
}

bool save(const Values& v) {
    platform::makeDirs(config::DATA_DIR);
    const std::string tmp = std::string(kPath) + ".tmp";
    FILE* f = std::fopen(tmp.c_str(), "wb");
    if (!f) return false;
    const std::string body = "{\n  \"lang\": \"" + json::escape(v.lang) + "\",\n  \"theme\": \"" +
                             kPalettes[(v.theme % THEMES + THEMES) % THEMES].id + "\",\n  \"sort\": \"" + std::to_string(v.sort) + "\",\n  \"device_token\": \"" +
                             json::escape(v.device_token) + "\",\n  \"paired_username\": \"" + json::escape(v.paired_username) + "\"\n}\n";
    bool ok = std::fwrite(body.data(), 1, body.size(), f) == body.size();
    ok = (std::fclose(f) == 0) && ok;
    if (!ok) { std::remove(tmp.c_str()); return false; }
    std::remove(kPath);
    return std::rename(tmp.c_str(), kPath) == 0;
}

}
