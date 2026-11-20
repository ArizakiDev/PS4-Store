#pragma once
#include <cmath>

namespace anim {

inline float approach(float v, float target, float k, float dt) {
    float t = 1.0f - std::exp(-k * dt);
    return v + (target - v) * t;
}

struct Smooth {
    float value = 0.f, target = 0.f, k = 12.f;
    Smooth() = default;
    explicit Smooth(float v, float speed = 12.f) : value(v), target(v), k(speed) {}
    void set(float t) { target = t; }
    void snap(float t) { value = target = t; }
    void update(float dt) {
        value = approach(value, target, k, dt);
        if (std::fabs(target - value) < 0.0005f) value = target;
    }
    bool settled() const { return value == target; }
};

inline float clamp01(float x) { return x < 0.f ? 0.f : (x > 1.f ? 1.f : x); }
inline float clampf(float x, float lo, float hi) { return x < lo ? lo : (x > hi ? hi : x); }

}
