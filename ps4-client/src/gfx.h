#pragma once
#include <SDL2/SDL.h>

namespace gfx {

void init(SDL_Renderer* renderer, SDL_Window* window);

Uint32 format();

SDL_Texture* makeTexture(SDL_Renderer* renderer, const unsigned char* rgba, int w, int h);

}
