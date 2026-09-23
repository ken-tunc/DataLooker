#include "catalog.h"

#include <utility>

#include "absl/strings/str_cat.h"
#include "absl/strings/str_join.h"
#include "absl/strings/str_split.h"

namespace datalooker {

std::optional<TablePath> Resolve(absl::Span<const std::string> path,
                                 const std::string& default_project) {
  std::vector<std::string> parts;
  for (const std::string& name : path) {
    for (absl::string_view part : absl::StrSplit(name, '.')) {
      parts.emplace_back(part);
    }
  }
  if (parts.size() == 2 && !default_project.empty()) {
    parts.insert(parts.begin(), default_project);
  }
  if (parts.size() != 3) return std::nullopt;
  return TablePath{parts[0], parts[1], parts[2]};
}

void TablesCatalog::Add(const TablePath& path,
                        std::unique_ptr<googlesql::Table> table) {
  tables_[path] = std::move(table);
}

absl::Status TablesCatalog::FindTable(
    const absl::Span<const std::string>& path, const googlesql::Table** table,
    const FindOptions& options) {
  *table = nullptr;
  std::optional<TablePath> resolved = Resolve(path, default_project_);
  if (resolved.has_value()) {
    auto found = tables_.find(*resolved);
    if (found != tables_.end()) {
      *table = found->second.get();
      return absl::OkStatus();
    }
  }
  return absl::NotFoundError(
      absl::StrCat("Table not found: ", absl::StrJoin(path, ".")));
}

}  // namespace datalooker
