#pragma once
#include <atomic>

namespace dns_block {

class Guard {
public:
    ~Guard() { stop(); }

    bool start();
    void stop();
    bool active() const { return active_.load(); }

private:
    std::atomic<bool> active_{false};
};

void restoreNow();

}
