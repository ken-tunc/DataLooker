#include "complete.h"

#include <algorithm>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "absl/status/status.h"
#include "absl/strings/ascii.h"
#include "absl/strings/match.h"
#include "absl/strings/str_cat.h"
#include "absl/strings/str_join.h"
#include "absl/strings/str_split.h"
#include "catalog.h"
#include "googlesql/public/analyzer.h"
#include "googlesql/public/analyzer_output.h"
#include "googlesql/public/builtin_function_options.h"
#include "googlesql/public/multi_catalog.h"
#include "googlesql/public/parse_resume_location.h"
#include "googlesql/public/parse_tokens.h"
#include "googlesql/public/simple_catalog.h"
#include "googlesql/public/types/type_factory.h"
#include "googlesql/resolved_ast/resolved_ast.h"

namespace datalooker {
namespace {

using ::googlesql::ParseToken;
using ::googlesql::ResolvedNode;
using json = nlohmann::json;

constexpr char kCursor[] = "__cursor__";

struct Span {
  size_t start;
  size_t end;
};

// A place the rest of the statement can be cut, and how many parentheses are
// open there.
struct Cut {
  size_t at;
  int open;
  // A `NULL` after a dot would be a name.
  bool after_dot;
};

size_t Start(const ParseToken& token) {
  return token.GetLocationRange().start().GetByteOffset();
}
size_t End(const ParseToken& token) {
  return token.GetLocationRange().end().GetByteOffset();
}
bool Is(const ParseToken& token, absl::string_view image) {
  return token.IsKeyword() && absl::EqualsIgnoreCase(token.GetImage(), image);
}

// A word being typed can spell a keyword on its way to a name: `or` is how
// `orders` begins.
bool IsWord(const ParseToken& token) {
  if (token.IsIdentifier()) return true;
  if (!token.IsKeyword()) return false;
  absl::string_view image = token.GetImage();
  return !image.empty() && std::all_of(image.begin(), image.end(), [](char c) {
    return absl::ascii_isalnum(c) || c == '_';
  });
}

std::string TypeName(const googlesql::Type* type) {
  return type->TypeName(googlesql::PRODUCT_EXTERNAL);
}

// Where the cursor is, read from the tokens around it.
struct Place {
  Span statement;
  // The word being typed, which a candidate replaces; empty at a word's start.
  Span replace;
  // `a.b` in `a.b.<cursor>`, whose type names what can follow the dot.
  std::optional<Span> member_of;
  // The tokens of that prefix, for a table name being typed after FROM.
  std::vector<std::string> path;
  bool after_from = false;
  // Inside a string or a comment, where nothing is completed.
  bool quiet = false;
  // The select list of the query whose `GROUP BY` the cursor is in, set
  // aside: grouping by the probe leaves it naming columns no longer grouped.
  std::optional<Span> select_list;
  // Where what follows the cursor can be cut, the statement's end last.
  std::vector<Cut> cuts;
};

// Clauses a `GROUP BY` cannot be looked for past.
bool EndsClause(const ParseToken& token) {
  for (absl::string_view keyword :
       {"SELECT", "FROM", "WHERE", "HAVING", "QUALIFY", "WINDOW", "ORDER", "LIMIT",
        "JOIN", "ON", "USING", "UNION", "INTERSECT", "EXCEPT", "WITH"}) {
    if (Is(token, keyword)) return true;
  }
  return false;
}

// Walks back from `from` within one query, over what is in parentheses, and
// stops at the first token `stop` accepts: that token's index, or -1. The
// parentheses of an expression the walk started in are left, but not those of
// a subquery.
template <typename Stop>
int Back(const std::vector<const ParseToken*>& tokens, int from, Stop stop) {
  int depth = 0;
  for (int i = from; i >= 0; --i) {
    if (Is(*tokens[i], ")")) {
      ++depth;
    } else if (Is(*tokens[i], "(")) {
      if (depth == 0) {
        const bool query = i + 1 < static_cast<int>(tokens.size()) &&
                           (Is(*tokens[i + 1], "SELECT") || Is(*tokens[i + 1], "WITH"));
        if (query) return -1;
        continue;
      }
      --depth;
    } else if (depth == 0 && stop(i)) {
      return i;
    }
  }
  return -1;
}

// The select list of the query whose `GROUP BY` the token after `before` is
// in, if it is in one.
std::optional<Span> GroupedSelectList(const std::vector<const ParseToken*>& tokens,
                                      int before) {
  const int by = Back(tokens, before, [&](int i) {
    return Is(*tokens[i], "BY") || EndsClause(*tokens[i]);
  });
  if (by < 1 || !Is(*tokens[by], "BY") || !Is(*tokens[by - 1], "GROUP")) {
    return std::nullopt;
  }
  const int from = Back(tokens, by - 2, [&](int i) {
    return Is(*tokens[i], "FROM") || Is(*tokens[i], "SELECT");
  });
  if (from < 0 || !Is(*tokens[from], "FROM")) return std::nullopt;
  const int select =
      Back(tokens, from - 1, [&](int i) { return Is(*tokens[i], "SELECT"); });
  if (select < 0) return std::nullopt;
  return Span{End(*tokens[select]), Start(*tokens[from])};
}

absl::StatusOr<Place> Locate(absl::string_view text, size_t cursor,
                             const googlesql::LanguageOptions& language) {
  googlesql::ParseTokenOptions options;
  options.include_comments = true;
  options.language_options = language;
  auto resume = googlesql::ParseResumeLocation::FromStringView(text);
  std::vector<ParseToken> all;
  absl::Status status = googlesql::GetParseTokens(options, &resume, &all);
  if (!status.ok()) return status;

  Place place;
  place.statement = {0, text.size()};
  std::vector<const ParseToken*> tokens;
  for (const ParseToken& token : all) {
    if (token.IsEndOfInput()) break;
    // A line comment runs to the end of its line, so a cursor at the end of
    // the text is still inside one that has no newline yet to end it.
    const bool open_line_comment = token.IsComment() &&
                                   !absl::StartsWith(token.GetImage(), "/*") &&
                                   !absl::EndsWith(token.GetImage(), "\n");
    if ((token.IsComment() || token.IsValue()) && Start(token) < cursor &&
        (cursor < End(token) || (open_line_comment && cursor == End(token)))) {
      place.quiet = true;
    }
    if (Is(token, ";")) {
      if (End(token) <= cursor) {
        place.statement.start = End(token);
        tokens.clear();
      } else if (place.statement.end == text.size()) {
        place.statement.end = Start(token);
      }
      continue;
    }
    if (token.IsComment() || Start(token) >= place.statement.end) continue;
    tokens.push_back(&token);
  }
  if (place.quiet) return place;

  // Tokens up to the cursor, the word it is in included.
  int last = -1;
  for (int i = 0; i < static_cast<int>(tokens.size()); ++i) {
    if (Start(*tokens[i]) < cursor) last = i;
  }
  place.replace = {cursor, cursor};
  int before = last;
  if (last >= 0 && IsWord(*tokens[last]) && cursor <= End(*tokens[last])) {
    place.replace = {Start(*tokens[last]), End(*tokens[last])};
    before = last - 1;
  }

  // `ident . ident . <word>`, read backwards while each piece touches the next.
  size_t edge = place.replace.start;
  while (before >= 1 && Is(*tokens[before], ".") && End(*tokens[before]) == edge &&
         tokens[before - 1]->IsIdentifier() &&
         End(*tokens[before - 1]) == Start(*tokens[before])) {
    edge = Start(*tokens[before - 1]);
    before -= 2;
  }
  if (edge != place.replace.start) {
    // The prefix runs from the first identifier to the last dot.
    size_t last_dot = place.replace.start - 1;
    place.member_of = Span{edge, last_dot};
    for (int i = before + 1; i < static_cast<int>(tokens.size()) &&
                             Start(*tokens[i]) < last_dot;
         ++i) {
      if (!tokens[i]->IsIdentifier()) continue;
      for (absl::string_view part : absl::StrSplit(tokens[i]->GetIdentifier(), '.')) {
        place.path.emplace_back(part);
      }
    }
  }
  if (before >= 0 && (Is(*tokens[before], "FROM") || Is(*tokens[before], "JOIN"))) {
    place.after_from = true;
  }
  place.select_list = GroupedSelectList(tokens, before);

  // Never inside a dotted name, where what is left would name another table.
  // The dot of an `a.` before the cursor does not start one.
  const auto dot_after_cursor = [&](const ParseToken* token) {
    return token != nullptr && Is(*token, ".") && Start(*token) >= place.replace.end;
  };
  int open = 0;
  const ParseToken* previous = nullptr;
  for (const ParseToken* token : tokens) {
    if (Start(*token) >= place.replace.end && !Is(*token, ".") &&
        !dot_after_cursor(previous)) {
      place.cuts.push_back({Start(*token), open, false});
    }
    if (Is(*token, "(")) ++open;
    if (Is(*token, ")")) --open;
    previous = token;
  }
  place.cuts.push_back({place.statement.end, open, dot_after_cursor(previous)});
  return place;
}

// One way the statement can end after the probe.
struct Ending {
  const Cut* cut;
  bool null;
};

// The ways the statement can end, most of it first: as it is, and then cut
// back, as it would read had the reader not yet written what does not parse or
// resolve. A cut is tried as it is and with a `NULL` where an operand or a
// condition was left unwritten.
std::vector<Ending> Endings(const Place& place) {
  std::vector<Ending> endings;
  for (auto cut = place.cuts.rbegin(); cut != place.cuts.rend(); ++cut) {
    if (cut->open < 0) continue;
    endings.push_back({&*cut, false});
    if (!cut->after_dot) endings.push_back({&*cut, true});
  }
  return endings;
}

// What follows the probe for an ending, made only when it is tried: each is
// most of the statement. Parentheses left open are closed, and the newlines
// keep what is added out of a line comment.
std::string Tail(absl::string_view text, const Place& place, const Ending& ending) {
  return absl::StrCat(
      text.substr(place.replace.end, ending.cut->at - place.replace.end),
      ending.null ? "\nNULL" : "",
      ending.cut->open == 0 ? "" : "\n" + std::string(ending.cut->open, ')'));
}

// The probes tried in turn. An undeclared parameter takes its type from an
// operand beside it but not from a clause or a function signature, so after
// the probe that adapts come ones of each type a clause or an argument most
// often wants. Each attempt costs about a millisecond.
struct Probe {
  std::string (*make)(const std::string& finder);
  const char* expected_type;
};

std::string Adapting(const std::string& finder) {
  return "IF(" + finder + " IS NULL, @__any__, @__any__)";
}
std::string Condition(const std::string& finder) {
  return "(" + finder + " IS NULL)";
}
template <const char* kType>
std::string Typed(const std::string& finder) {
  return absl::StrCat("IF(", finder, " IS NULL, CAST(NULL AS ", kType,
                      "), CAST(NULL AS ", kType, "))");
}
constexpr char kTimestamp[] = "TIMESTAMP";
constexpr char kDate[] = "DATE";
constexpr char kString[] = "STRING";
constexpr char kFloat[] = "FLOAT64";

constexpr Probe kProbes[] = {
    {&Adapting, nullptr},
    {&Condition, "BOOL"},
    {&Typed<kTimestamp>, kTimestamp},
    {&Typed<kDate>, kDate},
    {&Typed<kString>, kString},
    {&Typed<kFloat>, kFloat},
};

bool FindPath(const ResolvedNode* node, std::vector<const ResolvedNode*>& path) {
  path.push_back(node);
  if (node->node_kind() == googlesql::RESOLVED_PARAMETER &&
      node->GetAs<googlesql::ResolvedParameter>()->name() == kCursor) {
    return true;
  }
  std::vector<const ResolvedNode*> children;
  node->GetChildNodes(&children);
  for (const ResolvedNode* child : children) {
    if (FindPath(child, path)) return true;
  }
  path.pop_back();
  return false;
}

std::string LastPart(absl::string_view name) {
  size_t dot = name.rfind('.');
  return std::string(dot == absl::string_view::npos ? name : name.substr(dot + 1));
}

// The names a scan brings into scope and which of them qualify which columns.
// A subquery's scans sit under an expression and are not in scope outside it.
struct Names {
  std::set<std::string> range_variables;
  std::map<int, std::string> qualifier;
  std::set<int> elements;
};

void CollectNames(const ResolvedNode* node, Names* names) {
  switch (node->node_kind()) {
    case googlesql::RESOLVED_TABLE_SCAN: {
      const auto* scan = node->GetAs<googlesql::ResolvedTableScan>();
      std::string name =
          scan->alias().empty() ? LastPart(scan->table()->Name()) : scan->alias();
      names->range_variables.insert(name);
      for (const auto& column : scan->column_list()) {
        names->qualifier[column.column_id()] = name;
      }
      break;
    }
    case googlesql::RESOLVED_WITH_REF_SCAN: {
      const auto* scan = node->GetAs<googlesql::ResolvedWithRefScan>();
      names->range_variables.insert(scan->with_query_name());
      for (const auto& column : scan->column_list()) {
        names->qualifier[column.column_id()] = scan->with_query_name();
      }
      break;
    }
    case googlesql::RESOLVED_ARRAY_SCAN: {
      // `UNNEST(x) AS i` makes `i` a name of its own rather than a column.
      for (const auto& column :
           node->GetAs<googlesql::ResolvedArrayScan>()->element_column_list()) {
        names->range_variables.insert(column.name());
        names->elements.insert(column.column_id());
      }
      break;
    }
    default:
      break;
  }
  if (node->IsExpression()) return;
  std::vector<const ResolvedNode*> children;
  node->GetChildNodes(&children);
  for (const ResolvedNode* child : children) CollectNames(child, names);
}

// Every scan above the cursor, innermost first: what the scan reads is what an
// expression in it can name, and a subquery can name what its outer query
// reads as well.
json Scopes(const ResolvedNode* statement) {
  std::vector<const ResolvedNode*> path;
  json scopes = json::array();
  if (!FindPath(statement, path)) return scopes;
  std::set<int> seen;
  for (auto it = path.rbegin(); it != path.rend(); ++it) {
    if (!(*it)->IsScan()) continue;
    std::vector<const ResolvedNode*> children;
    (*it)->GetChildNodes(&children);
    Names names;
    json columns = json::array();
    for (const ResolvedNode* child : children) {
      if (child->IsScan()) CollectNames(child, &names);
    }
    for (const ResolvedNode* child : children) {
      if (!child->IsScan()) continue;
      for (const auto& column : child->GetAs<googlesql::ResolvedScan>()->column_list()) {
        // `$col1` and its like are the analyzer's names, not the reader's.
        if (absl::StartsWith(column.name(), "$")) continue;
        if (names.elements.contains(column.column_id())) continue;
        if (!seen.insert(column.column_id()).second) continue;
        json entry = {{"name", column.name()}, {"type", TypeName(column.type())}};
        auto qualifier = names.qualifier.find(column.column_id());
        if (qualifier != names.qualifier.end()) {
          entry["qualifier"] = qualifier->second;
        }
        columns.push_back(std::move(entry));
      }
    }
    if (columns.empty() && names.range_variables.empty()) continue;
    scopes.push_back({{"columns", std::move(columns)},
                      {"range_variables", names.range_variables}});
  }
  return scopes;
}

TablePath ReadPath(const json& value) {
  if (!value.is_array() || value.size() != 3) {
    throw InvalidParams("a table path is [project, dataset, table]");
  }
  return {value[0].get<std::string>(), value[1].get<std::string>(),
          value[2].get<std::string>()};
}

json Replace(const Span& span) { return {{"start", span.start}, {"end", span.end}}; }

// How many cuts of the statement are analyzed, and how many are found not to
// parse, before giving up. A statement that does not parse before the cursor
// fails every cut, and each costs a parse of the whole statement.
constexpr int kAnalyses = 4;
constexpr int kUnparsed = 16;

json Answer(const Place& place, const Probe& fitted,
            const googlesql::AnalyzerOutput& output) {
  json answer = {{"replace", Replace(place.replace)},
                 {"expected_type", fitted.expected_type ? json(fitted.expected_type)
                                                         : json(nullptr)}};
  if (place.member_of) {
    const googlesql::Type* type = output.undeclared_parameters().at(kCursor);
    json fields = json::array();
    if (type->IsStruct()) {
      for (const auto& field : type->AsStruct()->fields()) {
        fields.push_back({{"name", field.name}, {"type", TypeName(field.type)}});
      }
    }
    answer["context"] = "member";
    answer["fields"] = std::move(fields);
  } else {
    answer["context"] = "name";
    answer["scopes"] = Scopes(output.resolved_statement());
  }
  return answer;
}

}  // namespace

Analyzer::Analyzer() : builtins_("builtins") {
  language_.EnableMaximumLanguageFeatures();
  language_.SetSupportsAllStatementKinds();
  language_.set_product_mode(googlesql::PRODUCT_EXTERNAL);
  options_ = googlesql::AnalyzerOptions(language_);
  options_.set_allow_undeclared_parameters(true);
  builtins_.AddBuiltinFunctions(googlesql::BuiltinFunctionOptions(language_));
}

json Analyzer::Complete(const json& params) {
  const std::string text = params.at("text").get<std::string>();
  const size_t cursor = params.at("cursor").get<size_t>();
  if (cursor > text.size()) throw InvalidParams("the cursor is past the text");
  const std::string default_project = params.value("default_project", "");
  const json catalog = params.value("catalog", json::object());

  absl::StatusOr<Place> located = Locate(text, cursor, language_);
  if (!located.ok()) return {{"unresolved", located.status().message()}};
  const Place& place = *located;
  if (place.quiet) return {{"context", "none"}};
  if (place.after_from) {
    return {{"context", "table"}, {"replace", Replace(place.replace)},
            {"path", place.path}};
  }

  // The statement with the word under the cursor, and the prefix before it,
  // cut out: probes go where they were.
  const size_t cut = place.member_of ? place.member_of->start : place.replace.start;
  std::string head;
  if (place.select_list) {
    head = absl::StrCat(
        text.substr(place.statement.start, place.select_list->start - place.statement.start),
        " 1 ", text.substr(place.select_list->end, cut - place.select_list->end));
  } else {
    head = text.substr(place.statement.start, cut - place.statement.start);
  }
  const std::string finder =
      place.member_of
          ? absl::StrCat("IF(FALSE, ",
                         text.substr(place.member_of->start,
                                     place.member_of->end - place.member_of->start),
                         ", @", kCursor, ")")
          : absl::StrCat("@", kCursor);

  std::set<TablePath> known, absent;
  for (const json& table : catalog.value("tables", json::array())) {
    known.insert(ReadPath(table.at("path")));
  }
  for (const json& path : catalog.value("absent", json::array())) {
    absent.insert(ReadPath(path));
  }

  googlesql::TypeFactory types;
  TablesCatalog tables(default_project);
  std::unique_ptr<googlesql::MultiCatalog> root;
  // The statement's own complaint, which is what is said if no cut helps.
  std::optional<std::string> complaint;
  int analyzed = 0;
  int unparsed = 0;
  for (const Ending& ending : Endings(place)) {
    const std::string tail = Tail(text, place, ending);
    // Which tables the statement names is read from it with a probe in place,
    // since the half-typed statement does not parse.
    googlesql::TableNamesSet names;
    absl::Status extracted = googlesql::ExtractTableNamesFromStatement(
        head + kProbes[0].make(finder) + tail, options_, &names);
    if (!extracted.ok()) {
      if (!complaint) complaint = extracted.message();
      if (++unparsed == kUnparsed) break;
      continue;
    }
    std::set<TablePath> needs;
    for (const auto& name : names) {
      std::optional<TablePath> path = Resolve(name, default_project);
      if (path && !known.contains(*path) && !absent.contains(*path)) {
        needs.insert(*path);
      }
    }
    if (!needs.empty()) return {{"needs", needs}};

    if (root == nullptr) {
      for (const json& table : catalog.value("tables", json::array())) {
        const TablePath path = ReadPath(table.at("path"));
        std::vector<googlesql::SimpleTable::NameAndType> columns;
        for (const json& column : table.at("columns")) {
          const std::string name = column.at("name").get<std::string>();
          const std::string type_name = column.at("type").get<std::string>();
          const googlesql::Type* type = nullptr;
          absl::Status parsed =
              googlesql::AnalyzeType(type_name, options_, &builtins_, &types, &type);
          // A type GoogleSQL does not know is a column it cannot offer, and
          // no reason to offer nothing else: every table the app has read is
          // sent, whether or not this statement names it.
          if (!parsed.ok()) continue;
          columns.emplace_back(name, type);
        }
        tables.Add(path, std::make_unique<googlesql::SimpleTable>(
                             absl::StrJoin(path, "."), columns));
      }
      absl::Status created =
          googlesql::MultiCatalog::Create("request", {&tables, &builtins_}, &root);
      if (!created.ok()) throw std::runtime_error(std::string(created.message()));
    }

    std::unique_ptr<const googlesql::AnalyzerOutput> output;
    const Probe* fitted = nullptr;
    for (const Probe& probe : kProbes) {
      absl::Status status = googlesql::AnalyzeStatement(
          head + probe.make(finder) + tail, options_, root.get(), &types, &output);
      if (status.ok()) {
        fitted = &probe;
        break;
      }
      // The first probe's complaint is about the statement; later ones are
      // about the probe not being the type the place wanted.
      if (&probe == &kProbes[0] && !complaint) complaint = status.message();
    }
    if (fitted != nullptr) return Answer(place, *fitted, *output);
    // A statement that parses but does not resolve is cut back too, but only
    // a few times: each costs an analysis per probe.
    if (++analyzed == kAnalyses) break;
  }
  return {{"unresolved", complaint.value_or("nothing to complete")}};
}

}  // namespace datalooker
