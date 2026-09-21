use gcp_bigquery_client::model::field_type::FieldType;
use gcp_bigquery_client::model::table_field_schema::TableFieldSchema;
use serde_json::{Number, Value};

/// Beyond this, a JSON number no longer survives the trip through JavaScript's
/// `number`, so the value is sent as a string rather than silently rounded.
const SAFE_INTEGER: i64 = 9_007_199_254_740_991;

pub fn repeated(field: &TableFieldSchema) -> bool {
    field.mode.as_deref() == Some("REPEATED")
}

/// What the column is called where a reader is shown its type.
pub fn type_name(field: &TableFieldSchema) -> String {
    let name = scalar_name(&field.r#type);
    if repeated(field) {
        format!("ARRAY<{name}>")
    } else {
        name.to_string()
    }
}

/// BigQuery sends every value as text, whatever its type, so the schema beside
/// the rows is the only thing that says how to read one.
pub fn decode(cell: Option<&Value>, field: &TableFieldSchema) -> Value {
    decode_as(cell, field, repeated(field))
}

fn decode_as(cell: Option<&Value>, field: &TableFieldSchema, repeated: bool) -> Value {
    let Some(value) = cell else {
        return Value::Null;
    };
    if value.is_null() {
        return Value::Null;
    }
    if repeated {
        // A repeated field arrives as a list, each element wrapped in an
        // object of its own holding it under `v`.
        let Value::Array(items) = value else {
            return Value::Null;
        };
        let elements = items
            .iter()
            .map(|item| decode_as(item.get("v"), field, false))
            .collect();
        return Value::Array(elements);
    }
    match field.r#type {
        FieldType::Record | FieldType::Struct => record(value, field),
        _ => scalar(value, &field.r#type),
    }
}

/// A record arrives as its fields in order under `f`, each holding its value
/// under `v`. What they are called is the schema's to say, not the row's.
fn record(value: &Value, field: &TableFieldSchema) -> Value {
    let (Some(Value::Array(cells)), Some(fields)) = (value.get("f"), field.fields.as_ref()) else {
        return Value::Null;
    };
    let named = fields
        .iter()
        .zip(cells)
        .map(|(field, cell)| {
            (
                field.name.clone(),
                decode_as(cell.get("v"), field, repeated(field)),
            )
        })
        .collect();
    Value::Object(named)
}

fn scalar(value: &Value, kind: &FieldType) -> Value {
    // Everything BigQuery sends is a string. Anything else is not what the
    // schema said it would be, and is passed on as it arrived.
    let Value::String(text) = value else {
        return value.clone();
    };
    match kind {
        FieldType::Integer | FieldType::Int64 => {
            text.parse::<i64>().map_or_else(|_| value.clone(), from_i64)
        }
        FieldType::Float | FieldType::Float64 => {
            text.parse::<f64>().map_or_else(|_| value.clone(), from_f64)
        }
        FieldType::Boolean | FieldType::Bool => Value::Bool(text == "true"),
        // The text of a JSON column is JSON, and a reader is better served by
        // the value than by its punctuation.
        FieldType::Json => serde_json::from_str(text).unwrap_or_else(|_| value.clone()),
        // NUMERIC and BIGNUMERIC hold more digits than a JSON number keeps,
        // and a date or a timestamp is text to begin with.
        _ => value.clone(),
    }
}

fn from_i64(value: i64) -> Value {
    // `i64::MIN.abs()` has no positive i64 to be, so compare the magnitudes.
    if value.unsigned_abs() <= SAFE_INTEGER.unsigned_abs() {
        Value::Number(value.into())
    } else {
        Value::String(value.to_string())
    }
}

fn from_f64(value: f64) -> Value {
    // NaN and the infinities have no JSON number form.
    Number::from_f64(value)
        .map(Value::Number)
        .unwrap_or_else(|| Value::String(value.to_string()))
}

fn scalar_name(kind: &FieldType) -> &'static str {
    match kind {
        FieldType::String => "STRING",
        FieldType::Bytes => "BYTES",
        FieldType::Integer | FieldType::Int64 => "INT64",
        FieldType::Float | FieldType::Float64 => "FLOAT64",
        FieldType::Numeric => "NUMERIC",
        FieldType::Bignumeric => "BIGNUMERIC",
        FieldType::Boolean | FieldType::Bool => "BOOL",
        FieldType::Timestamp => "TIMESTAMP",
        FieldType::Date => "DATE",
        FieldType::Time => "TIME",
        FieldType::Datetime => "DATETIME",
        FieldType::Record | FieldType::Struct => "STRUCT",
        FieldType::Geography => "GEOGRAPHY",
        FieldType::Json => "JSON",
        FieldType::Interval => "INTERVAL",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn field(name: &str, kind: FieldType) -> TableFieldSchema {
        TableFieldSchema::new(name, kind)
    }

    fn many(name: &str, kind: FieldType) -> TableFieldSchema {
        TableFieldSchema {
            mode: Some("REPEATED".to_string()),
            ..field(name, kind)
        }
    }

    /// One cell as the wire holds it: the text BigQuery sends for a value.
    fn cell(text: &str) -> Value {
        json!(text)
    }

    #[test]
    fn a_missing_or_null_cell_is_null() {
        let column = field("n", FieldType::Int64);
        assert_eq!(decode(None, &column), Value::Null);
        assert_eq!(decode(Some(&Value::Null), &column), Value::Null);
    }

    #[test]
    fn whole_numbers_past_the_safe_range_stay_text() {
        let column = field("n", FieldType::Int64);
        assert_eq!(decode(Some(&cell("42")), &column), json!(42));
        assert_eq!(
            decode(Some(&cell("9007199254740992")), &column),
            json!("9007199254740992")
        );
    }

    #[test]
    fn a_float_is_a_number_unless_it_has_no_number_to_be() {
        let column = field("x", FieldType::Float64);
        assert_eq!(decode(Some(&cell("1.5")), &column), json!(1.5));
        assert_eq!(decode(Some(&cell("NaN")), &column), json!("NaN"));
    }

    #[test]
    fn numerics_keep_their_digits_as_text() {
        let column = field("price", FieldType::Bignumeric);
        let many_digits = "123456789012345678901234567890.12";
        assert_eq!(
            decode(Some(&cell(many_digits)), &column),
            json!(many_digits)
        );
    }

    #[test]
    fn a_boolean_is_one_of_two_words() {
        let column = field("ok", FieldType::Bool);
        assert_eq!(decode(Some(&cell("true")), &column), json!(true));
        assert_eq!(decode(Some(&cell("false")), &column), json!(false));
    }

    #[test]
    fn json_arrives_as_the_value_rather_than_its_punctuation() {
        let column = field("doc", FieldType::Json);
        assert_eq!(
            decode(Some(&cell(r#"{"a":[1]}"#)), &column),
            json!({"a": [1]})
        );
        // Text a JSON column should not be holding is passed on as it came.
        assert_eq!(decode(Some(&cell("{oops")), &column), json!("{oops"));
    }

    #[test]
    fn a_repeated_field_is_a_list_of_what_it_repeats() {
        let column = many("ids", FieldType::Int64);
        let wire = json!([{ "v": "1" }, { "v": "2" }]);
        assert_eq!(decode(Some(&wire), &column), json!([1, 2]));
    }

    #[test]
    fn a_record_is_named_by_the_schema_rather_than_the_row() {
        let column = TableFieldSchema {
            fields: Some(vec![
                field("id", FieldType::Int64),
                field("name", FieldType::String),
            ]),
            ..field("customer", FieldType::Record)
        };
        let wire = json!({ "f": [{ "v": "7" }, { "v": "Ada" }] });

        assert_eq!(
            decode(Some(&wire), &column),
            json!({"id": 7, "name": "Ada"})
        );
    }

    #[test]
    fn a_repeated_record_is_a_list_of_them() {
        let column = TableFieldSchema {
            mode: Some("REPEATED".to_string()),
            fields: Some(vec![field("id", FieldType::Int64)]),
            ..field("items", FieldType::Record)
        };
        let wire = json!([
            { "v": { "f": [{ "v": "1" }] } },
            { "v": { "f": [{ "v": "2" }] } }
        ]);

        assert_eq!(decode(Some(&wire), &column), json!([{"id": 1}, {"id": 2}]));
    }

    #[test]
    fn a_column_says_what_it_holds_and_whether_it_holds_many() {
        assert_eq!(type_name(&field("s", FieldType::String)), "STRING");
        assert_eq!(type_name(&many("ids", FieldType::Int64)), "ARRAY<INT64>");
        assert_eq!(type_name(&field("c", FieldType::Record)), "STRUCT");
    }
}
