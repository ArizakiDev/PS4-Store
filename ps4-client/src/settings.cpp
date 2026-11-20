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
    {"oled", {245, 245, 247, 255}, {140, 146, 160, 255}, {10, 132, 255, 255}, {64, 156, 255, 255}, {52, 60, 80, 255}, {12, 12, 14, 255},
     {214, 218, 228, 255}, {0, 0, 0, 255}, {0, 0, 0, 5, 5, 8, 0, 18, 40}},
    {"classic", {255, 255, 255, 255}, {159, 180, 214, 255}, {0, 112, 209, 255}, {46, 155, 255, 255}, {0, 114, 206, 255}, {8, 24, 58, 255},
     {205, 220, 245, 255}, {3, 11, 28, 255}, {3, 11, 28, 10, 43, 110, 0, 67, 156}},
    {"midnight", {250, 246, 255, 255}, {176, 160, 208, 255}, {139, 92, 246, 255}, {176, 132, 255, 255}, {124, 77, 220, 255}, {26, 16, 52, 255},
     {222, 210, 245, 255}, {12, 6, 28, 255}, {10, 5, 26, 38, 18, 84, 72, 28, 132}},
    {"light", {28, 30, 36, 255}, {98, 106, 122, 255}, {0, 113, 227, 255}, {90, 170, 255, 255}, {196, 204, 218, 255}, {250, 251, 253, 255},
     {52, 58, 72, 255}, {236, 239, 245, 255}, {238, 241, 247, 228, 234, 245, 214, 224, 242}},
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
                             kPalettes[(v.theme % THEMES + THEMES) % THEMES].id + "\",\n  \"device_token\": \"" +
                             json::escape(v.device_token) + "\",\n  \"paired_username\": \"" + json::escape(v.paired_username) + "\"\n}\n";
    bool ok = std::fwrite(body.data(), 1, body.size(), f) == body.size();
    ok = (std::fclose(f) == 0) && ok;
    if (!ok) { std::remove(tmp.c_str()); return false; }
    std::remove(kPath);
    return std::rename(tmp.c_str(), kPath) == 0;
}

}
