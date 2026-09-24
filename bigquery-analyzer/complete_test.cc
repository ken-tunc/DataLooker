#include "complete.h"

#include <chrono>
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
  // A line comment with nothing after it is still open at the end of the text.
  EXPECT_EQ(Ask("SELECT * FROM sales.orders o -- o.|")["context"], "none");
  EXPECT_EQ(Ask("SELECT * FROM sales.orders o # o.|")["context"], "none");
  // A block comment that has ended is not where the cursor is.
  EXPECT_EQ(Ask("SELECT /* x */ o.| FROM sales.orders o")["context"], "member");
}

TEST(Complete, ReadsPastWhatIsNotWrittenYet) {
  EXPECT_THAT(Columns(Ask("SELECT | FROM sales.orders o WHERE")),
              IsSupersetOf({"o.order_id"}));
  EXPECT_THAT(Fields(Ask("SELECT * FROM sales.orders o WHERE o.| AND")),
              ElementsAre("order_id", "customer_id", "ordered_at", "items", "shipping"));
  EXPECT_EQ(Ask("SELECT * FROM sales.orders o WHERE o.| GROUP BY")["context"], "member");
  EXPECT_THAT(
      Fields(Ask("SELECT c.| FROM sales.orders o JOIN sales.customers c ON")),
      ElementsAre("customer_id", "name"));
  EXPECT_THAT(Fields(Ask("SELECT o.| FROM sales.orders o JOIN sales.customers c "
                         "USING (customer_id) WHERE c.name =")),
              ElementsAre("order_id", "customer_id", "ordered_at", "items", "shipping"));
  // A subquery left open is closed.
  EXPECT_THAT(Fields(Ask("SELECT * FROM sales.orders WHERE customer_id IN "
                         "(SELECT c.| FROM sales.customers c WHERE")),
              ElementsAre("customer_id", "name"));
  // A column misspelt after the cursor is cut away too.
  EXPECT_THAT(Fields(Ask("SELECT o.| FROM sales.orders o WHERE o.ordr_id = 1")),
              ElementsAre("order_id", "customer_id", "ordered_at", "items", "shipping"));
}

TEST(Complete, GivesUpOnAStatementThatDoesNotParseBeforeTheCursor) {
  // No cut adds the `END`, so none parses. Trying every one takes seconds,
  // and the helper answers nothing else meanwhile.
  std::string statement = "SELECT CASE WHEN TRUE THEN | FROM sales.orders o WHERE";
  for (int i = 0; i < 2000; ++i) statement += " o.order_id = 1 AND";
  Shared();  // Built before the clock starts: it is slow to build.
  const auto started = std::chrono::steady_clock::now();
  EXPECT_TRUE(Ask(statement).contains("unresolved"));
  EXPECT_LT(std::chrono::steady_clock::now() - started, std::chrono::seconds(1));
}

TEST(Complete, DoesNotCutATableNameIntoAnotherOne) {
  // `shop.sales` would be read as the table `sales` of the dataset `shop`.
  EXPECT_FALSE(Ask("SELECT o.| FROM shop.sales.", json::array()).contains("needs"));
}

TEST(Complete, OffersWhatAGroupByCanGroup) {
  json answer = Ask("SELECT customer_id, COUNT(*) FROM sales.orders o GROUP BY |");
  EXPECT_EQ(answer["context"], "name");
  EXPECT_THAT(Columns(answer), IsSupersetOf({"o.customer_id", "o.ordered_at"}));
  EXPECT_THAT(Fields(Ask("SELECT customer_id, COUNT(*) FROM sales.orders o "
                         "GROUP BY o.customer_id, o.|")),
              ElementsAre("order_id", "customer_id", "ordered_at", "items", "shipping"));
  EXPECT_THAT(Columns(Ask("SELECT order_id, COUNT(*) FROM sales.orders o "
                          "GROUP BY COALESCE(|, 0)")),
              IsSupersetOf({"o.order_id"}));
  // What the GROUP BY already names by alias or position still resolves.
  EXPECT_THAT(Columns(Ask("SELECT o.order_id AS id, o.customer_id c, COUNT(*) "
                          "FROM sales.orders o GROUP BY id, c, 3, |")),
              IsSupersetOf({"o.ordered_at"}));
  // Only the query the cursor is in has its select list set aside.
  EXPECT_THAT(Columns(Ask("SELECT * FROM (SELECT customer_id, COUNT(*) "
                          "FROM sales.customers c GROUP BY |)")),
              IsSupersetOf({"c.name"}));
}

TEST(Complete, LeavesWhatItCannotResolveToTheCaller) {
  // No FROM yet: nothing says what `o` is.
  EXPECT_TRUE(Ask("SELECT o.|").contains("unresolved"));
}

TEST(Complete, LeavesOutAColumnOfATypeItDoesNotKnow) {
  json odd = {{"path", {"shop", "sales", "t"}},
              {"columns",
               {{{"name", "x"}, {"type", "NOT A TYPE"}}, {{"name", "y"}, {"type", "INT64"}}}}};
  EXPECT_THAT(Fields(Ask("SELECT t.| FROM sales.t", json::array({odd}))), ElementsAre("y"));
  // Nor does it stop a statement that names another table.
  EXPECT_THAT(Fields(Ask("SELECT c.| FROM sales.customers c", json::array({odd, kCustomers}))),
              ElementsAre("customer_id", "name"));
}

TEST(Complete, RefusesARequestWithoutWhatTheProtocolAsksFor) {
  EXPECT_THROW(Shared().Complete({{"cursor", 0}}), json::exception);
  EXPECT_THROW(Shared().Complete({{"text", ""}, {"cursor", 5}}), InvalidParams);
}

}  // namespace
}  // namespace datalooker
