#ifndef DATALOOKER_BIGQUERY_ANALYZER_CATALOG_H_
#define DATALOOKER_BIGQUERY_ANALYZER_CATALOG_H_

#include <array>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "absl/status/status.h"
#include "absl/types/span.h"
#include "googlesql/public/catalog.h"
#include "googlesql/public/simple_catalog.h"

namespace datalooker {

// A table as BigQuery names it: project, dataset, table.
using TablePath = std::array<std::string, 3>;

// Reads a name the way BigQuery does. `a.b.c` in backquotes is one identifier
// to GoogleSQL and three to BigQuery, and a name with no project is in the
// connection's own. Anything that is not three parts then is not a table here.
std::optional<TablePath> Resolve(absl::Span<const std::string> path,
                                 const std::string& default_project);

// The tables a request brought, and nothing else: which tables exist is the
// caller's to say, since only the caller can ask BigQuery. Names are compared
// as written, because BigQuery's own are case-sensitive.
class TablesCatalog : public googlesql::Catalog {
 public:
  explicit TablesCatalog(std::string default_project)
      : default_project_(std::move(default_project)) {}

  void Add(const TablePath& path, std::unique_ptr<googlesql::Table> table);

  std::string FullName() const override { return "tables"; }

  absl::Status FindTable(const absl::Span<const std::string>& path,
                         const googlesql::Table** table,
                         const FindOptions& options) override;

 private:
  std::string default_project_;
  std::map<TablePath, std::unique_ptr<googlesql::Table>> tables_;
};

}  // namespace datalooker

#endif  // DATALOOKER_BIGQUERY_ANALYZER_CATALOG_H_
