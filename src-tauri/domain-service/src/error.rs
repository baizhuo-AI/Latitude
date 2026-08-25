use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use thiserror::Error;

pub type AppResult<T> = Result<T, AppError>;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("not found: {0}")]
    NotFound(String),
    #[error("invalid request: {0}")]
    Invalid(String),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("dangerous operation confirmation required: {0}")]
    ConfirmationRequired(String),
    #[error("database error")]
    Database(#[from] sqlx::Error),
    #[error("I/O error")]
    Io(#[from] std::io::Error),
    #[error("serialization error")]
    Serialization(#[from] serde_json::Error),
    #[error("internal error: {0}")]
    Internal(String),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code) = match &self {
            Self::NotFound(_) => (StatusCode::NOT_FOUND, "not_found"),
            Self::Invalid(_) => (StatusCode::BAD_REQUEST, "invalid_request"),
            Self::Conflict(_) => (StatusCode::CONFLICT, "conflict"),
            Self::ConfirmationRequired(_) => {
                (StatusCode::PRECONDITION_REQUIRED, "confirmation_required")
            }
            Self::Database(_) | Self::Io(_) | Self::Serialization(_) | Self::Internal(_) => {
                (StatusCode::INTERNAL_SERVER_ERROR, "internal_error")
            }
        };
        let public_message = match &self {
            Self::Database(_) => "database operation failed".to_string(),
            Self::Io(_) => "local file operation failed".to_string(),
            Self::Serialization(_) => "serialization failed".to_string(),
            _ => self.to_string(),
        };
        (
            status,
            Json(json!({
                "ok": false,
                "error": { "code": code, "message": public_message }
            })),
        )
            .into_response()
    }
}
