#pragma once

enum Btn { B_UP, B_DOWN, B_LEFT, B_RIGHT, B_CROSS, B_CIRCLE, B_SQUARE, B_TRIANGLE, B_L1, B_R1, B_OPTIONS, B_TOUCHPAD, B_COUNT };

class Input {
public:
    bool init();
    void update(float dt);

    bool pressed(Btn b) const { return pressed_[b]; }
    bool held(Btn b) const { return down_[b]; }
    int userId() const { return user_; }

private:
    int handle_ = -1;
    int user_ = 0;
    bool down_[B_COUNT] = {};
    bool prev_[B_COUNT] = {};
    bool pressed_[B_COUNT] = {};
    float repeat_[B_COUNT] = {};
};
