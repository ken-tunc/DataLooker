use serde_json::{Number, Value};
use sqlx::postgres::{PgRow, PgTypeInfo, PgTypeKind};
use sqlx::{Column, Row, TypeInfo, ValueRef};

/// Beyond this, JavaScript rounds a number, so it is sent as a string.
const SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// The built-in types `cell_to_json` reads, by the name sqlx gives them, which
/// is also their upper-cased `pg_type.typname`.
const DECODED: &[&str] = &[
    "BOOL",
    "INT2",
    "INT4",
    "INT8",
    "FLOAT4",
    "FLOAT8",
    "NUMERIC",
    "TEXT",
    "VARCHAR",
    "BPCHAR",
    "NAME",
    "CHAR",
    "UUID",
    "JSON",
    "JSONB",
    "DATE",
    "TIME",
    "TIMESTAMP",
    "TIMESTAMPTZ",
    "BYTEA",
];

/// Whether a value of a built-in type, or an array of one, reaches the
/// frontend as itself rather than as `<type>`.
pub fn decodes_builtin(typname: &str) -> bool {
    DECODED.contains(&typname.to_ascii_uppercase().as_str())
}

pub fn row_to_json(row: &PgRow) -> Vec<Value> {
    row.columns()
        .iter()
        .enumerate()
        .map(|(index, column)| cell_to_json(row, index, column.type_info()))
        .collect()
}

/// Array elements are nullable, hence `Option<T>` in the array branch.
macro_rules! decode {
    ($row:expr, $index:expr, $is_array:expr, $ty:ty, $convert:expr) => {
        if $is_array {
            or_error(
                $row.try_get::<Vec<Option<$ty>>, _>($index)
                    .map(|items| json_array(items, $convert)),
            )
        } else {
            or_error($row.try_get::<$ty, _>($index).map($convert))
        }
    };
}

fn cell_to_json(row: &PgRow, index: usize, type_info: &PgTypeInfo) -> Value {
    match row.try_get_raw(index) {
        Ok(raw) if raw.is_null() => return Value::Null,
        Err(e) => return unsupported(format!("error: {e}")),
        Ok(_) => {}
    }

    // An array column reports its own type name (`_int4`), never the element's,
    // so unwrap it here and let every arm below decode both forms.
    let (is_array, element) = match type_info.kind() {
        PgTypeKind::Array(element) => (true, element),
        _ => (false, type_info),
    };

    // A user-defined enum's type name is the enum's own, so it cannot be
    // matched below. PostgreSQL sends the label as UTF-8 in both wire formats,
    // though sqlx declines to read an enum it was not told of as a `String`.
    if matches!(element.kind(), PgTypeKind::Enum(_)) && !is_array {
        return match row.try_get_unchecked::<String, _>(index) {
            Ok(label) => Value::String(label),
            Err(_) => unsupported(element.name()),
        };
    }

    // The list, not the arms, says what is decoded, so that `decodes_builtin`
    // cannot promise a type the arms have lost.
    let name = element.name();
    if !DECODED.contains(&name) {
        return unsupported(name);
    }
    match name {
        "BOOL" => decode!(row, index, is_array, bool, Value::Bool),
        "INT2" => decode!(row, index, is_array, i16, |v| Value::Number(v.into())),
        "INT4" => decode!(row, index, is_array, i32, |v| Value::Number(v.into())),
        "INT8" => decode!(row, index, is_array, i64, i64_to_json),
        "FLOAT4" => decode!(row, index, is_array, f32, |v| f64_to_json(v.into())),
        "FLOAT8" => decode!(row, index, is_array, f64, f64_to_json),
        "NUMERIC" => decode!(row, index, is_array, sqlx::types::BigDecimal, |v| {
            Value::String(without_padding(v.to_string()))
        }),
        "TEXT" | "VARCHAR" | "BPCHAR" | "NAME" | "CHAR" => {
            decode!(row, index, is_array, String, Value::String)
        }
        "UUID" => decode!(row, index, is_array, uuid::Uuid, |v| Value::String(
            v.to_string()
        )),
        "JSON" | "JSONB" => decode!(row, index, is_array, Value, |v| v),
        "DATE" => decode!(row, index, is_array, time::Date, |v| Value::String(
            v.to_string()
        )),
        "TIME" => decode!(row, index, is_array, time::Time, |v| Value::String(
            v.to_string()
        )),
        "TIMESTAMP" => decode!(row, index, is_array, time::PrimitiveDateTime, |v| {
            Value::String(v.to_string())
        }),
        "TIMESTAMPTZ" => decode!(row, index, is_array, time::OffsetDateTime, |v| {
            Value::String(v.to_string())
        }),
        "BYTEA" => decode!(row, index, is_array, Vec<u8>, |v| Value::String(hex(&v))),
        _ => unsupported(name),
    }
}

fn json_array<T>(items: Vec<Option<T>>, convert: impl Fn(T) -> Value) -> Value {
    Value::Array(
        items
            .into_iter()
            .map(|item| item.map(&convert).unwrap_or(Value::Null))
            .collect(),
    )
}

fn or_error(decoded: Result<Value, sqlx::Error>) -> Value {
    decoded.unwrap_or_else(|e| unsupported(format!("decode error: {e}")))
}

/// Better than failing the whole query over one unknown type.
fn unsupported(what: impl std::fmt::Display) -> Value {
    Value::String(format!("<{what}>"))
}

/// sqlx decodes a NUMERIC into whole groups of four digits, so `12.34` arrives
/// as `12.3400`. The padding is the decoder's, not the value's.
fn without_padding(numeric: String) -> String {
    if !numeric.contains('.') {
        return numeric;
    }
    let trimmed = numeric.trim_end_matches('0');
    trimmed.strip_suffix('.').unwrap_or(trimmed).to_string()
}

fn i64_to_json(value: i64) -> Value {
    // `i64::MIN.abs()` has no positive i64 to be, so compare the magnitudes.
    if value.unsigned_abs() <= SAFE_INTEGER.unsigned_abs() {
        Value::Number(value.into())
    } else {
        Value::String(value.to_string())
    }
}

fn f64_to_json(value: f64) -> Value {
    // NaN and the infinities have no JSON number form.
    Number::from_f64(value)
        .map(Value::Number)
        .unwrap_or_else(|| Value::String(value.to_string()))
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes.iter().fold(String::from("\\x"), |mut out, byte| {
        let _ = write!(out, "{byte:02x}");
        out
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bytea_renders_in_postgres_hex_notation() {
        assert_eq!(hex(&[0x00, 0xff, 0x10]), "\\x00ff10");
        assert_eq!(hex(&[]), "\\x");
    }

    #[test]
    fn numerics_keep_their_digits_and_lose_the_padding() {
        for (padded, expected) in [
            ("12.3400", "12.34"),
            ("100", "100"),
            ("0.00000100", "0.000001"),
            ("0.0000", "0"),
            ("-1.2000", "-1.2"),
        ] {
            assert_eq!(without_padding(padded.to_string()), expected);
        }
    }

    #[test]
    fn integers_past_the_safe_range_become_strings() {
        assert_eq!(
            i64_to_json(SAFE_INTEGER),
            Value::Number(SAFE_INTEGER.into())
        );
        assert_eq!(
            i64_to_json(SAFE_INTEGER + 1),
            Value::String("9007199254740992".into())
        );
        assert_eq!(
            i64_to_json(-SAFE_INTEGER - 1),
            Value::String("-9007199254740992".into())
        );
        assert_eq!(
            i64_to_json(i64::MIN),
            Value::String("-9223372036854775808".into())
        );
    }

    #[test]
    fn floats_without_a_json_form_become_strings() {
        assert_eq!(
            f64_to_json(1.5),
            Value::Number(Number::from_f64(1.5).unwrap())
        );
        assert_eq!(f64_to_json(f64::NAN), Value::String("NaN".into()));
        assert_eq!(f64_to_json(f64::INFINITY), Value::String("inf".into()));
    }
}

/// What only a PostgreSQL can say; see `testing` for which one, and when it is skipped.
#[cfg(test)]
mod live {
    use serde_json::json;

    use crate::drivers::postgres::testing::*;

    #[tokio::test(flavor = "multi_thread")]
    async fn values_reach_the_frontend_as_json() {
        let Some(session) = session_or_skip().await else {
            return;
        };

        let result = run(
            &session,
            "SELECT 9007199254740993::int8 AS big,
                    1.25::float8 AS float,
                    12.34::numeric AS exact,
                    '{\"a\": 1}'::jsonb AS document,
                    ARRAY[1, NULL, 3]::int4[] AS numbers,
                    '\\x0a0b'::bytea AS bytes,
                    '2026-09-20'::date AS day,
                    '00000000-0000-0000-0000-000000000001'::uuid AS identifier",
        )
        .await
        .unwrap();

        assert_eq!(
            result.rows[0],
            vec![
                // Past 2^53 a JSON number would reach JavaScript rounded.
                json!("9007199254740993"),
                json!(1.25),
                json!("12.34"),
                json!({"a": 1}),
                json!([1, null, 3]),
                json!("\\x0a0b"),
                json!("2026-09-20"),
                json!("00000000-0000-0000-0000-000000000001"),
            ]
        );
    }
}
