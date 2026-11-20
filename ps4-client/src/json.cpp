#include "json.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace json {
namespace {

struct Parser {
    const char* p;
    const char* end;
    int depth = 0;

    void ws() { while (p < end && (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r')) ++p; }
    bool eat(char c) { ws(); if (p < end && *p == c) { ++p; return true; } return false; }

    static void utf8(std::string& s, unsigned cp) {
        if (cp < 0x80) s += (char)cp;
        else if (cp < 0x800) { s += (char)(0xC0 | (cp >> 6)); s += (char)(0x80 | (cp & 0x3F)); }
        else if (cp < 0x10000) { s += (char)(0xE0 | (cp >> 12)); s += (char)(0x80 | ((cp >> 6) & 0x3F)); s += (char)(0x80 | (cp & 0x3F)); }
        else { s += (char)(0xF0 | (cp >> 18)); s += (char)(0x80 | ((cp >> 12) & 0x3F)); s += (char)(0x80 | ((cp >> 6) & 0x3F)); s += (char)(0x80 | (cp & 0x3F)); }
    }

    bool hex4(unsigned& v) {
        if (end - p < 4) return false;
        v = 0;
        for (int i = 0; i < 4; ++i) {
            char c = *p++;
            v <<= 4;
            if (c >= '0' && c <= '9') v |= c - '0';
            else if (c >= 'a' && c <= 'f') v |= c - 'a' + 10;
            else if (c >= 'A' && c <= 'F') v |= c - 'A' + 10;
            else return false;
        }
        return true;
    }

    bool string(std::string& out) {
        ws();
        if (p >= end || *p != '"') return false;
        ++p;
        out.clear();
        while (p < end) {
            char c = *p++;
            if (c == '"') return true;
            if (c != '\\') { out += c; continue; }
            if (p >= end) return false;
            char e = *p++;
            switch (e) {
                case '"': out += '"'; break;
                case '\\': out += '\\'; break;
                case '/': out += '/'; break;
                case 'b': out += '\b'; break;
                case 'f': out += '\f'; break;
                case 'n': out += '\n'; break;
                case 'r': out += '\r'; break;
                case 't': out += '\t'; break;
                case 'u': {
                    unsigned cp;
                    if (!hex4(cp)) return false;
                    if (cp >= 0xD800 && cp < 0xDC00) {
                        unsigned lo;
                        if (end - p >= 6 && p[0] == '\\' && p[1] == 'u') {
                            p += 2;
                            if (!hex4(lo)) return false;
                            if (lo >= 0xDC00 && lo < 0xE000) cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                        }
                    }
                    utf8(out, cp);
                    break;
                }
                default: return false;
            }
        }
        return false;
    }

    bool skip() {
        ws();
        if (p >= end || ++depth > 16) return false;
        bool ok = true;
        if (*p == '"') { std::string t; ok = string(t); }
        else if (*p == '{' || *p == '[') {
            char open = *p, close = open == '{' ? '}' : ']';
            ++p;
            ws();
            if (p < end && *p == close) ++p;
            else {
                for (;;) {
                    if (open == '{') { std::string k; if (!string(k) || !eat(':')) { ok = false; break; } }
                    if (!skip()) { ok = false; break; }
                    if (eat(',')) continue;
                    ok = eat(close);
                    break;
                }
            }
        } else {
            while (p < end && *p != ',' && *p != '}' && *p != ']' && *p != ' ' && *p != '\n' && *p != '\r' && *p != '\t') ++p;
        }
        --depth;
        return ok;
    }

    bool scalar(std::string& out) {
        ws();
        if (p >= end) return false;
        if (*p == '"') return string(out);
        if (*p == '{' || *p == '[') { out.clear(); return skip(); }
        const char* s = p;
        while (p < end && *p != ',' && *p != '}' && *p != ']' && *p != ' ' && *p != '\n' && *p != '\r' && *p != '\t') ++p;
        out.assign(s, p);
        if (out == "null") out.clear();
        return !out.empty() || s != p;
    }

    bool object(Object& out) {
        if (!eat('{')) return false;
        out.clear();
        ws();
        if (p < end && *p == '}') { ++p; return true; }
        for (;;) {
            std::string key, val;
            if (!string(key) || !eat(':') || !scalar(val)) return false;
            out[key] = val;
            if (eat(',')) continue;
            return eat('}');
        }
    }
};

}

bool parseObjectArray(const std::string& text, std::vector<Object>& out) {
    Parser ps{text.data(), text.data() + text.size()};
    out.clear();
    if (text.size() >= 3 && (unsigned char)text[0] == 0xEF && (unsigned char)text[1] == 0xBB && (unsigned char)text[2] == 0xBF) ps.p += 3;
    if (!ps.eat('[')) return false;
    ps.ws();
    if (ps.p < ps.end && *ps.p == ']') return true;
    for (;;) {
        Object o;
        if (!ps.object(o)) return false;
        out.push_back(std::move(o));
        if (ps.eat(',')) continue;
        return ps.eat(']');
    }
}

bool parseObject(const std::string& text, Object& out) {
    Parser ps{text.data(), text.data() + text.size()};
    if (text.size() >= 3 && (unsigned char)text[0] == 0xEF && (unsigned char)text[1] == 0xBB && (unsigned char)text[2] == 0xBF) ps.p += 3;
    return ps.object(out);
}

std::string rawField(const std::string& text, const std::string& key) {
    Parser ps{text.data(), text.data() + text.size()};
    if (!ps.eat('{')) return "";
    ps.ws();
    if (ps.p < ps.end && *ps.p == '}') return "";
    for (;;) {
        std::string k;
        if (!ps.string(k) || !ps.eat(':')) return "";
        ps.ws();
        const char* start = ps.p;
        if (!ps.skip()) return "";
        if (k == key) return std::string(start, ps.p);
        if (!ps.eat(',')) return "";
    }
}

std::vector<std::string> stringArrayField(const std::string& text, const std::string& key) {
    std::vector<std::string> out;
    const std::string raw = rawField(text, key);
    Parser ps{raw.data(), raw.data() + raw.size()};
    if (!ps.eat('[')) return out;
    ps.ws();
    if (ps.p < ps.end && *ps.p == ']') return out;
    for (;;) {
        std::string v;
        if (!ps.string(v)) break;
        out.push_back(std::move(v));
        if (!ps.eat(',')) break;
    }
    return out;
}

bool objectArrayField(const std::string& text, const std::string& key, std::vector<Object>& out) {
    out.clear();
    const std::string raw = rawField(text, key);
    return !raw.empty() && parseObjectArray(raw, out);
}

std::string escape(const std::string& s) {
    std::string o;
    for (unsigned char c : s) {
        switch (c) {
            case '"': o += "\\\""; break;
            case '\\': o += "\\\\"; break;
            case '\n': o += "\\n"; break;
            case '\r': o += "\\r"; break;
            case '\t': o += "\\t"; break;
            default:
                if (c < 0x20) { char b[8]; std::snprintf(b, sizeof b, "\\u%04x", c); o += b; }
                else o += (char)c;
        }
    }
    return o;
}

}
