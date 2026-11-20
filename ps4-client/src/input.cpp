#include "input.h"

#include <cstdint>
#include <cstring>

#include "platform.h"

extern "C" {
int sceUserServiceInitialize(void* params);
int sceUserServiceGetInitialUser(int* userId);
int scePadInit();
int scePadOpen(int userId, int type, int index, void* param);
int scePadReadState(int handle, void* data);
}

namespace {

enum : uint32_t {
    PAD_OPTIONS = 0x00000008, PAD_UP = 0x00000010, PAD_RIGHT = 0x00000020, PAD_DOWN = 0x00000040, PAD_LEFT = 0x00000080,
    PAD_L1 = 0x00000400, PAD_R1 = 0x00000800, PAD_TRIANGLE = 0x00001000, PAD_CIRCLE = 0x00002000,
    PAD_CROSS = 0x00004000, PAD_SQUARE = 0x00008000, PAD_TOUCHPAD = 0x00100000,
};

struct PadRaw {
    uint32_t buttons;
    uint8_t lx, ly;
    uint8_t rest[506];
};

constexpr float REPEAT_FIRST = 0.20f;
constexpr float REPEAT_NEXT = 0.055f;

}

bool Input::init() {
    struct UserServiceInitParams { uint32_t priority; };
    UserServiceInitParams params{0x2FF};
    int rc = sceUserServiceInitialize(&params);
    platform::bootLogf("input: sceUserServiceInitialize rc=0x%08X", (unsigned)rc);
    int user = 0;
    rc = sceUserServiceGetInitialUser(&user);
    platform::bootLogf("input: GetInitialUser rc=0x%08X user=%d", (unsigned)rc, user);
    user_ = user;
    if (rc < 0) return false;
    rc = scePadInit();
    platform::bootLogf("input: scePadInit rc=0x%08X", (unsigned)rc);
    if (rc < 0) return false;
    handle_ = scePadOpen(user, 0 , 0, nullptr);
    platform::bootLogf("input: scePadOpen handle=%d", handle_);
    return handle_ >= 0;
}

void Input::update(float dt) {
    std::memcpy(prev_, down_, sizeof down_);
    std::memset(down_, 0, sizeof down_);
    std::memset(pressed_, 0, sizeof pressed_);

    if (handle_ >= 0) {
        PadRaw d;
        std::memset(&d, 0, sizeof d);
        if (scePadReadState(handle_, &d) >= 0) {
            uint32_t b = d.buttons;
            down_[B_UP] = (b & PAD_UP) || d.ly < 0x40;
            down_[B_DOWN] = (b & PAD_DOWN) || d.ly > 0xC0;
            down_[B_LEFT] = (b & PAD_LEFT) || d.lx < 0x40;
            down_[B_RIGHT] = (b & PAD_RIGHT) || d.lx > 0xC0;
            down_[B_CROSS] = b & PAD_CROSS;
            down_[B_CIRCLE] = b & PAD_CIRCLE;
            down_[B_SQUARE] = b & PAD_SQUARE;
            down_[B_TRIANGLE] = b & PAD_TRIANGLE;
            down_[B_L1] = b & PAD_L1;
            down_[B_R1] = b & PAD_R1;
            down_[B_OPTIONS] = b & PAD_OPTIONS;
            down_[B_TOUCHPAD] = b & PAD_TOUCHPAD;
        }
    }

    for (int i = 0; i < B_COUNT; ++i) {
        bool directional = i <= B_RIGHT;
        if (down_[i] && !prev_[i]) {
            pressed_[i] = true;
            repeat_[i] = REPEAT_FIRST;
        } else if (down_[i] && directional) {
            repeat_[i] -= dt;
            if (repeat_[i] <= 0.f) { pressed_[i] = true; repeat_[i] += REPEAT_NEXT; }
        }
    }
}
