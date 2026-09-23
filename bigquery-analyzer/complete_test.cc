#include "complete.h"

#include <set>
#include <string>
#include <vector>

#include "gmock/gmock.h"
#include "gtest/gtest.h"
#include "nlohmann/json.hpp"

namespace datalooker {
namespace {

using json = nlohmann::json;
using ::testing::ElementsAre;
using ::testing::IsSupersetOf;

const json kOrders = {
    {"path", {"shop", "sales", "orders"}},
    {"columns",
     {{{"name", "order_id"}, {"type", "INT64"}},
      {{"name", "customer_id"}, {"type", "INT64"}},
      {{"name", "ordered_at"}, {"type", "TIMESTAMP"}},
      {{"name", "items"}, {"type", "ARRAY<STRUCT<sku STRING, qty INT64>>"}},
      {{"name", "shipping"}, {"type", "STRUCT<city STRING, zip STRING>"}}}}};
const json kCustomers = {{"path", {"shop", "sales", "customers"}},
                         {"columns",
                          {{{"name", "customer_id"}, {"type", "INT64"}},
                           {{"name", "name"}, {"type", "STRING"}}}}};

// The analyzer is slow to build and the same for every request.
Analyzer& Shared() {
  static Analyzer* analyzer = new Analyzer();
  return *analyzer;
}

// `|` marks the cursor.
json Ask(std::string marked, json tables = {kOrders, kCustomers},
         json absent = json::array()) {
  const size_t cursor = marked.find('|');
  marked.erase(cursor, 1);
  return Shared().Complete({{"text", marked},
                            {"cursor", cursor},
                            {"default_project", "shop"},
                            {"catalog", {{"tables", tables}, {"absent", absent}}}});
}

std::vector<std::string> Fields(const json& answer) {
  std::vector<std::string> names;
  for (const json& field : answer.at("fields")) names.push_back(field.at("name"));
  return names;
}

// Every column the scopes offer, as `qualifier.name` where it has one.
std::vector<std::string> Columns(const json& answer, size_t scope = 0) {
  std::vector<std::string> names;
  for (const json& column : answer.at("scopes").at(scope).at("columns")) {
    names.push_back(column.contains("qualifier")
                        ? column["qualifier"].get<std::string>() + "." +
                              column["name"].get<std::string>()
                        : column["name"].get<std::string>());
  }
  return names;
}

TEST(Complete, NamesTheColumnsOfARangeVariable) {
  json answer = Ask("SELECT o.| FROM sales.orders o");
  EXPECT_EQ(answer["context"], "member");
  EXPECT_THAT(Fields(answer), ElementsAre("order_id", "customer_id", "ordered_at",
                                          "items", "shipping"));
  EXPECT_EQ(answer["replace"], json({{"start", 9}, {"end", 9}}));
}

TEST(Complete, ReplacesTheWordBeingTyped) {
  json answer = Ask("SELECT o.ord| FROM sales.orders o WHERE o.order_id > 1");
  EXPECT_EQ(answer["context"], "member");
  EXPECT_EQ(answer["replace"], json({{"start", 9}, {"end", 12}}));
}

TEST(Complete, NamesTheFieldsOfAStruct) {
  EXPECT_THAT(Fields(Ask("SELECT o.shipping.| FROM sales.orders o")),
              ElementsAre("city", "zip"));
}

TEST(Complete, NamesTheFieldsOfAnUnnestedElement) {
  EXPECT_THAT(Fields(Ask("SELECT i.| FROM sales.orders o, UNNEST(o.items) i")),
              ElementsAre("sku", "qty"));
}

TEST(Complete, NamesTheColumnsOfACommonTableExpression) {
  EXPECT_THAT(Fields(Ask("WITH recent AS (SELECT order_id FROM sales.orders) "
                         "SELECT r.| FROM recent r")),
              ElementsAre("order_id"));
}

TEST(Complete, ReadsAFullyQualifiedNameTheWayBigQueryDoes) {
  EXPECT_THAT(Fields(Ask("SELECT c.| FROM `shop.sales.customers` c")),
              ElementsAre("customer_id", "name"));
  EXPECT_THAT(Fields(Ask("SELECT c.| FROM `shop`.sales.customers c")),
              ElementsAre("customer_id", "name"));
}

TEST(Complete, FitsAMemberIntoAComparison) {
  EXPECT_EQ(Ask("SELECT 1 FROM sales.orders o WHERE o.| = 1")["context"], "member");
}

TEST(Complete, OffersWhatTheFromClauseBringsIntoScope) {
  json answer = Ask("SELECT | FROM sales.orders o JOIN sales.customers c USING (customer_id)");
  EXPECT_EQ(answer["context"], "name");
  EXPECT_THAT(Columns(answer), IsSupersetOf({"o.order_id", "c.name"}));
  EXPECT_EQ(answer["scopes"][0]["range_variables"], json({"c", "o"}));
}

TEST(Complete, SaysWhatTypeAClauseWants) {
  json where = Ask("SELECT 1 FROM sales.orders o WHERE |");
  EXPECT_EQ(where["expected_type"], "BOOL");
  EXPECT_THAT(Columns(where), IsSupersetOf({"o.ordered_at"}));

  json argument =
      Ask("SELECT 1 FROM sales.orders o WHERE TIMESTAMP_SUB(|, INTERVAL 1 DAY) > o.ordered_at");
  EXPECT_EQ(argument["expected_type"], "TIMESTAMP");
}

TEST(Complete, OffersAnUnnestedElementAsANameRatherThanAColumn) {
  json answer = Ask("SELECT o.order_id, | FROM sales.orders o, UNNEST(o.items) i");
  EXPECT_EQ(answer["scopes"][0]["range_variables"], json({"i", "o"}));
  for (const std::string& column : Columns(answer)) EXPECT_NE(column, "i");
}

TEST(Complete, OffersTheOuterQueryInsideASubquery) {
  json answer = Ask(
      "SELECT 1 FROM sales.orders o WHERE EXISTS "
      "(SELECT 1 FROM sales.customers c WHERE c.customer_id = |)");
  EXPECT_THAT(Columns(answer, 0), ElementsAre("c.customer_id", "c.name"));
  std::vector<std::string> outer;
  for (size_t i = 1; i < answer["scopes"].size(); ++i) {
    for (const std::string& column : Columns(answer, i)) outer.push_back(column);
  }
  EXPECT_THAT(outer, IsSupersetOf({"o.order_id"}));
}

TEST(Complete, AsksForTheTablesItWasNotGiven) {
  json answer = Ask("SELECT o.| FROM sales.orders o JOIN `shop.sales.customers` c ON TRUE",
                    json::array());
  EXPECT_EQ(answer["needs"],
            json({{"shop", "sales", "customers"}, {"shop", "sales", "orders"}}));
}

TEST(Complete, DoesNotAskForATableKnownNotToExist) {
  json answer = Ask("SELECT o.| FROM sales.ordrs o", json::array(),
                    json({{"shop", "sales", "ordrs"}}));
  EXPECT_FALSE(answer.contains("needs"));
  EXPECT_TRUE(answer.contains("unresolved"));
}

TEST(Complete, DoesNotAskForACommonTableExpression) {
  json answer = Ask("WITH recent AS (SELECT 1 AS x) SELECT r.| FROM recent r",
                    json::array());
  EXPECT_THAT(Fields(answer), ElementsAre("x"));
}

TEST(Complete, SaysWhenATableNameIsBeingTyped) {
  json answer = Ask("SELECT * FROM sales.or|");
  EXPECT_EQ(answer["context"], "table");
  EXPECT_EQ(answer["path"], json({"sales"}));
  EXPECT_EQ(answer["replace"], json({{"start", 20}, {"end", 22}}));
  EXPECT_EQ(Ask("SELECT * FROM sales.orders o JOIN |")["context"], "table");
}

TEST(Complete, KeepsToTheStatementTheCursorIsIn) {
  json answer = Ask("SELECT nonsense FROM nowhere; SELECT o.| FROM sales.orders o; SELEC");
  EXPECT_EQ(answer["context"], "member");
}

TEST(Complete, OffersNothingInsideAStringOrAComment) {
  EXPECT_EQ(Ask("SELECT 'o.|' FROM sales.orders o")["context"], "none");
  EXPECT_EQ(Ask("SELECT 1 -- o.|\nFROM sales.orders o")["context"], "none");
}

TEST(Complete, LeavesWhatItCannotResolveToTheCaller) {
  // No FROM yet: nothing says what `o` is.
  EXPECT_TRUE(Ask("SELECT o.|").contains("unresolved"));
}

TEST(Complete, RefusesATypeBigQueryWouldNotHaveWritten) {
  json broken = {{"path", {"shop", "sales", "t"}},
                 {"columns", {{{"name", "x"}, {"type", "NOT A TYPE"}}}}};
  EXPECT_THROW(Ask("SELECT t.| FROM sales.t", json::array({broken})), InvalidParams);
}

}  // namespace
}  // namespace datalooker
