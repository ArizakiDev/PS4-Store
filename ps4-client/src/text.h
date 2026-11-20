#pragma once
#include <SDL2/SDL.h>

#include <map>
#include <string>
#include <unordered_map>
#include <vector>

class TextRenderer {
public:
    enum Align { Left, Center, Right };

    TextRenderer(SDL_Renderer* r) : renderer_(r) {}
    ~TextRenderer();

    static bool readFile(const std::string& path, std::vector<unsigned char>& out);

    bool loadBytes(std::vector<unsigned char>&& data, const std::string& label);

    bool load(const std::string& ttfPath);

    void draw(const std::string& text, int px, float x, float y, SDL_Color color, float alpha = 1.f,
              Align align = Left, int maxWidth = 0);
    int width(const std::string& text, int px);

    void endFrame();

private:
    struct Entry { SDL_Texture* tex = nullptr; int w = 0, h = 0; unsigned used = 0; Uint8 alphaSet = 255; };
    Entry* get(const std::string& text, int px, SDL_Color color);
    std::string fit(const std::string& text, int px, int maxWidth);
    int measure(const std::string& text, int px);

    SDL_Renderer* renderer_;
    std::vector<unsigned char> font_;
    void* info_ = nullptr;
    std::map<std::string, Entry> cache_;
    std::unordered_map<std::string, int> widthCache_;
    std::unordered_map<std::string, std::string> fitCache_;
    unsigned frame_ = 0;
};
