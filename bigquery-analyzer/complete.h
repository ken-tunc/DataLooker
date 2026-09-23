#ifndef DATALOOKER_BIGQUERY_ANALYZER_COMPLETE_H_
#define DATALOOKER_BIGQUERY_ANALYZER_COMPLETE_H_

#include <stdexcept>

#include "googlesql/public/analyzer_options.h"
#include "googlesql/public/language_options.h"
#include "googlesql/public/simple_catalog.h"
#include "nlohmann/json.hpp"

namespace datalooker {

// A request that does not say what the protocol asks it to — a missing field,
// a type BigQuery would not have written. What the text says is never this.
class InvalidParams : public std::invalid_argument {
 public:
  using std::invalid_argument::invalid_argument;
};

class Analyzer {
 public:
  Analyzer();

  // What could go where the cursor is. See README.md for the shape of the
  // request and of each answer.
  nlohmann::json Complete(const nlohmann::json& params);

 private:
  googlesql::LanguageOptions language_;
  googlesql::AnalyzerOptions options_;
  // Built once: the function signatures take most of a start-up to register,
  // and they are the same for every request.
  googlesql::SimpleCatalog builtins_;
};

}  // namespace datalooker

#endif  // DATALOOKER_BIGQUERY_ANALYZER_COMPLETE_H_
