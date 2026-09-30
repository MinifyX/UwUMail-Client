//! Models running on this computer: a started Ollama or LM Studio is offered in the assistant's
//! settings with one click, with the models it has installed.
//!
//! Only the loopback is asked, at the programs' own default ports, and only when the settings are
//! open. Nothing goes out of this computer; that is why loopback is fine here although providers'
//! addresses are otherwise held to the SSRF rules (`provider::check_base_url`).

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use super::provider::{self, Model, ProviderKind};

/// How long one program may take to answer. It runs on this computer, or not at all.
const WAIT: Duration = Duration::from_millis(1500);

/// A program that may run here: its kind, its name, where it is asked and the address saved.
#[derive(Debug, Clone, Copy)]
pub struct Candidate {
    pub kind: ProviderKind,
    pub name: &'static str,
    /// Where the installed models are listed.
    pub probe: &'static str,
    /// The provider's address as it is saved (Ollama's gets `/v1` added when saved).
    pub base_url: &'static str,
}

/// Ollama (`/api/tags`) and LM Studio (OpenAI-compatible, `/v1/models`) at their default ports.
pub const CANDIDATES: [Candidate; 2] = [
    Candidate {
        kind: ProviderKind::Ollama,
        name: "Ollama",
        probe: "http://127.0.0.1:11434/api/tags",
        base_url: "http://127.0.0.1:11434",
    },
    Candidate {
        kind: ProviderKind::OpenAiCompatible,
        name: "LM Studio",
        probe: "http://127.0.0.1:1234/v1/models",
        base_url: "http://127.0.0.1:1234/v1",
    },
];

/// A program that answered, with its installed models.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub kind: &'static str,
    pub name: &'static str,
    pub base_url: &'static str,
    pub models: Vec<Model>,
}

async fn ask(http: &reqwest::Client, candidate: Candidate) -> Option<Found> {
    let work = async {
        let response =
            http.get(candidate.probe).header(reqwest::header::ACCEPT, "application/json").send().await.ok()?;
        if !response.status().is_success() {
            return None;
        }
        // A model list is small; anything big is not one of these programs.
        let bytes = response.bytes().await.ok().filter(|b| b.len() <= 1024 * 1024)?;
        let value: Value = serde_json::from_slice(&bytes).ok()?;
        (value.get("models").is_some_and(Value::is_array) || value.get("data").is_some_and(Value::is_array))
            .then(|| provider::model_list(&value))
    };
    let models = tokio::time::timeout(WAIT, work).await.ok()??;
    Some(Found { kind: candidate.kind.as_str(), name: candidate.name, base_url: candidate.base_url, models })
}

/// The candidates that answer, in their order, asked at the same time.
pub async fn local_models(http: &reqwest::Client, candidates: &[Candidate]) -> Vec<Found> {
    futures::future::join_all(candidates.iter().map(|candidate| ask(http, *candidate)))
        .await
        .into_iter()
        .flatten()
        .collect()
}

#[cfg(test)]
mod tests {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::*;

    /// Answers every request on 127.0.0.1 with `body`; the address is leaked for a `&'static str`.
    async fn serve(status: u16, body: &'static str) -> &'static str {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = Box::leak(format!("http://{}", listener.local_addr().unwrap()).into_boxed_str());
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut buffer = [0u8; 4096];
                let _ = socket.read(&mut buffer).await;
                let head = format!(
                    "HTTP/1.1 {status} Stub\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    body.len()
                );
                let _ = socket.write_all(head.as_bytes()).await;
                let _ = socket.write_all(body.as_bytes()).await;
                let _ = socket.shutdown().await;
            }
        });
        address
    }

    fn candidate(kind: ProviderKind, name: &'static str, probe: String) -> Candidate {
        let probe: &'static str = Box::leak(probe.into_boxed_str());
        Candidate { kind, name, probe, base_url: probe }
    }

    #[tokio::test]
    async fn offers_what_answers_with_its_models() {
        let http = provider::http_client().unwrap();
        let ollama = serve(
            200,
            r#"{"models":[{"name":"llama3.2:latest","model":"llama3.2:latest"},{"name":"qwen3:8b","model":"qwen3:8b"}]}"#,
        )
        .await;
        let studio = serve(200, r#"{"object":"list","data":[{"id":"google/gemma-3-4b","object":"model"}]}"#).await;
        let broken = serve(500, r#"{"error":"no"}"#).await;
        let other = serve(200, r#"{"hello":"world"}"#).await;
        // A port nobody listens on: bound and let go again.
        let closed = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            format!("http://{}", listener.local_addr().unwrap())
        };
        let candidates = [
            candidate(ProviderKind::Ollama, "Ollama", format!("{ollama}/api/tags")),
            candidate(ProviderKind::OpenAiCompatible, "LM Studio", format!("{studio}/v1/models")),
            candidate(ProviderKind::OpenAiCompatible, "Broken", format!("{broken}/v1/models")),
            candidate(ProviderKind::OpenAiCompatible, "Other", format!("{other}/v1/models")),
            candidate(ProviderKind::Ollama, "Off", format!("{closed}/api/tags")),
        ];
        let found = local_models(&http, &candidates).await;
        assert_eq!(found.len(), 2, "{found:?}");
        assert_eq!(found[0].kind, "ollama");
        assert_eq!(found[0].models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["llama3.2:latest", "qwen3:8b"]);
        assert_eq!(found[1].name, "LM Studio");
        assert_eq!(found[1].kind, "openaiCompatible");
        assert_eq!(found[1].models[0].id, "google/gemma-3-4b");
    }

    #[test]
    fn the_saved_addresses_pass_the_providers_own_check() {
        for candidate in CANDIDATES {
            assert!(candidate.probe.starts_with("http://127.0.0.1:"));
            provider::check_base_url(candidate.kind, candidate.base_url).expect("a loopback address is fine");
        }
    }
}
