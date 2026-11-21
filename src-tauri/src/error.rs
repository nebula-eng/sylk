use serde::{Serialize, Serializer};

/// 统一的错误类型。所有命令都返回 `Result<T, AppError>`，
/// 前端拿到的就是一句可直接展示的中文消息。
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Message(String),

    #[error("数据库操作失败：{0}")]
    Database(#[from] rusqlite::Error),

    #[error("网络请求失败：{0}")]
    Network(#[from] reqwest::Error),

    #[error("文件读写失败：{0}")]
    Io(#[from] std::io::Error),

    #[error("数据格式错误：{0}")]
    Json(#[from] serde_json::Error),
}

impl AppError {
    pub fn msg(text: impl Into<String>) -> Self {
        Self::Message(text.into())
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
