// Answers requests on stdin, one at a time, until stdin closes. Each message is
// framed the way a language server's is — a Content-Length header, a blank
// line, and that many bytes of JSON-RPC — so the app reads and writes this one
// with the code it already has for those.

#include <cstdio>
#include <iostream>
#include <optional>
#include <string>

#include "absl/strings/ascii.h"
#include "absl/strings/match.h"
#include "absl/strings/numbers.h"
#include "complete.h"
#include "nlohmann/json.hpp"

namespace {

using json = nlohmann::json;

constexpr char kVersion[] = "0.2.0";
constexpr char kGoogleSql[] = "2026.9.2";

// The most a message may claim to be, as on the app's side.
constexpr size_t kMost = 16 * 1024 * 1024;

std::optional<std::string> Read() {
  std::optional<size_t> length;
  std::string line;
  bool started = false;
  while (std::getline(std::cin, line)) {
    started = true;
    if (!line.empty() && line.back() == '\r') line.pop_back();
    if (line.empty()) break;
    constexpr absl::string_view kHeader = "Content-Length:";
    if (absl::StartsWith(line, kHeader)) {
      size_t value;
      if (absl::SimpleAtoi(absl::StripAsciiWhitespace(
                               absl::string_view(line).substr(kHeader.size())),
                           &value)) {
        length = value;
      }
    }
  }
  if (!started || !length || *length > kMost) return std::nullopt;
  std::string body(*length, '\0');
  if (!std::cin.read(body.data(), *length)) return std::nullopt;
  return body;
}

void Write(const json& message) {
  const std::string body = message.dump();
  std::cout << "Content-Length: " << body.size() << "\r\n\r\n" << body;
  std::cout.flush();
}

json Error(const json& id, int code, const std::string& message) {
  return {{"jsonrpc", "2.0"},
          {"id", id},
          {"error", {{"code", code}, {"message", message}}}};
}

}  // namespace

int main() {
  std::ios::sync_with_stdio(false);
  datalooker::Analyzer analyzer;

  while (std::optional<std::string> body = Read()) {
    json request = json::parse(*body, nullptr, /*allow_exceptions=*/false);
    if (request.is_discarded() || !request.is_object()) {
      Write(Error(nullptr, -32700, "not a JSON-RPC message"));
      continue;
    }
    const json id = request.value("id", json(nullptr));
    const std::string method = request.value("method", "");
    try {
      json result;
      if (method == "hello") {
        result = {{"version", kVersion}, {"googlesql", kGoogleSql}};
      } else if (method == "complete") {
        result = analyzer.Complete(request.value("params", json::object()));
      } else {
        Write(Error(id, -32601, "no method " + method));
        continue;
      }
      Write({{"jsonrpc", "2.0"}, {"id", id}, {"result", std::move(result)}});
    } catch (const datalooker::InvalidParams& e) {
      Write(Error(id, -32602, e.what()));
    } catch (const json::exception& e) {
      Write(Error(id, -32602, e.what()));
    } catch (const std::exception& e) {
      Write(Error(id, -32603, e.what()));
    }
  }
  return 0;
}
