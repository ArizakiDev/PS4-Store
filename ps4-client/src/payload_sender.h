#pragma once
#include <atomic>
#include <mutex>
#include <string>
#include <thread>

#include "catalog.h"

namespace payload {

constexpr int BINLOADER_PORT = 9090;

class Sender {
public:
    struct Event { unsigned serial = 0; bool ok = true; std::string message; };

    Sender() = default;
    ~Sender();

    void send(const Game& g);
    bool busy() const { return busy_.load(); }
    Event lastEvent() const;

private:
    void post(bool ok, const std::string& msg);
    void run(Game g);

    std::thread th_;
    std::atomic<bool> busy_{false};
    mutable std::mutex m_;
    Event event_;
};

}
