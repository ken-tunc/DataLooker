//! The base protocol a language server speaks over its stdio: a
//! `Content-Length` header, a blank line, and that many bytes of JSON-RPC.
//! What a message means is the client's to say — nothing here parses one.

use std::io;

use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// A header claiming more is not allocated for.
const MOST: usize = 16 * 1024 * 1024;

/// `None` when the server stops talking; a stream that ends mid-message is an
/// error.
pub async fn read<R: AsyncBufRead + Unpin>(from: &mut R) -> io::Result<Option<String>> {
    let mut length = None;
    let mut line = String::new();
    let mut started = false;

    loop {
        line.clear();
        if from.read_line(&mut line).await? == 0 {
            return if started {
                Err(invalid("the headers end where the message should be"))
            } else {
                Ok(None)
            };
        }
        started = true;
        let header = line.trim_end_matches(['\r', '\n']);
        if header.is_empty() {
            break;
        }
        // Content-Type, if sent, is ignored.
        if let Some(value) = header.strip_prefix("Content-Length:") {
            length = Some(
                value
                    .trim()
                    .parse::<usize>()
                    .map_err(|e| invalid(&format!("Content-Length: {e}")))?,
            );
        }
    }

    let length = length.ok_or_else(|| invalid("a message with no Content-Length"))?;
    if length > MOST {
        return Err(invalid(&format!("a message of {length} bytes")));
    }

    let mut body = vec![0u8; length];
    from.read_exact(&mut body).await?;
    String::from_utf8(body)
        .map(Some)
        .map_err(|e| invalid(&e.to_string()))
}

/// The length is counted in bytes.
pub async fn write<W: AsyncWrite + Unpin>(to: &mut W, message: &str) -> io::Result<()> {
    to.write_all(format!("Content-Length: {}\r\n\r\n", message.len()).as_bytes())
        .await?;
    to.write_all(message.as_bytes()).await?;
    to.flush().await
}

fn invalid(what: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, what.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn framed(body: &str) -> Vec<u8> {
        let mut out = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
        out.extend_from_slice(body.as_bytes());
        out
    }

    async fn reading(bytes: &[u8]) -> io::Result<Option<String>> {
        read(&mut tokio::io::BufReader::new(bytes)).await
    }

    #[tokio::test]
    async fn reads_the_messages_one_after_another() {
        let mut bytes = framed(r#"{"id":1}"#);
        bytes.extend(framed(r#"{"id":2}"#));
        let mut stream = tokio::io::BufReader::new(&bytes[..]);

        assert_eq!(read(&mut stream).await.unwrap().unwrap(), r#"{"id":1}"#);
        assert_eq!(read(&mut stream).await.unwrap().unwrap(), r#"{"id":2}"#);
        assert!(read(&mut stream).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn counts_a_message_in_bytes_rather_than_characters() {
        let mut written = Vec::new();
        write(&mut written, r#"{"a":"日本語"}"#).await.unwrap();

        assert!(written.starts_with(b"Content-Length: 17\r\n\r\n"));
        assert_eq!(
            reading(&written).await.unwrap().unwrap(),
            r#"{"a":"日本語"}"#
        );
    }

    #[tokio::test]
    async fn reads_a_message_whatever_else_its_headers_say() {
        let body = r#"{"id":1}"#;
        let bytes = format!(
            "Content-Length: {}\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n{body}",
            body.len()
        );

        assert_eq!(reading(bytes.as_bytes()).await.unwrap().unwrap(), body);
    }

    #[tokio::test]
    async fn an_ending_between_messages_is_the_end_and_not_an_error() {
        assert!(reading(b"").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn an_ending_inside_one_is_an_error() {
        assert!(reading(b"Content-Length: 8\r\n").await.is_err());
        assert!(reading(b"Content-Length: 8\r\n\r\n{\"id\"").await.is_err());
    }

    #[tokio::test]
    async fn refuses_a_message_it_cannot_measure_or_would_not_hold() {
        assert!(reading(b"Content-Type: text\r\n\r\n{}").await.is_err());
        assert!(reading(b"Content-Length: ten\r\n\r\n{}").await.is_err());
        assert!(reading(b"Content-Length: 99999999999\r\n\r\n{}")
            .await
            .is_err());
    }
}
