#pragma once
#include <SDL2/SDL.h>
#include <string>

namespace settings {

constexpr int THEMES = 4;
struct Palette {
    const char* id;
    SDL_Color text, muted, accent, cyan, border, surface;
    SDL_Color body;
    SDL_Color bar;
    int grad[9];
};
const Palette& palette(int theme);

struct Values {
    int theme = 1;
    std::string lang;
    std::string device_token, paired_username;
};

Values load();
bool save(const Values& v);

}
