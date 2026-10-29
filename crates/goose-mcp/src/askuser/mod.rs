use std::{
    borrow::Cow,
    collections::{BTreeMap, HashMap},
};

use indoc::formatdoc;
use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{
        BooleanSchema, CallToolResult, ContentBlock, ElicitRequestParams, ElicitationAction,
        ElicitationSchema, EnumSchema, ErrorData, Implementation, InitializeResult,
        LegacyEnumSchema, PrimitiveSchemaDefinition, ServerCapabilities, ServerConfig,
        StringSchema,
    },
    schemars::JsonSchema,
    service::RequestContext,
    tool, tool_handler, tool_router, RoleServer, ServerHandler,
};
use serde::{Deserialize, Serialize};

const KEY_NOTE: &str = "Optional Instructions";
const MAX_NAME_LEN: usize = 72;
const MAX_OPTIONS: usize = 10;
const MAX_QUESTIONS: usize = 8;

fn default_true() -> bool {
    true
}

/// An answer choice: a short label, or a `{label, description}` object.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum OptionItem {
    Label(String),
    Object {
        label: String,
        #[serde(default)]
        description: Option<String>,
    },
}

impl OptionItem {
    fn into_option(self) -> Option<AskOption> {
        match self {
            OptionItem::Label(label) => {
                let label = collapse_ws(&label);
                (!label.is_empty()).then(|| AskOption {
                    label,
                    description: String::new(),
                    field: String::new(),
                })
            }
            OptionItem::Object { label, description } => {
                let label = collapse_ws(&label);
                (!label.is_empty()).then(|| AskOption {
                    label,
                    description: description.unwrap_or_default().trim().to_string(),
                    field: String::new(),
                })
            }
        }
    }
}

#[derive(Debug, Clone)]
struct AskOption {
    label: String,
    description: String,
    /// Schema property name for multi-select booleans.
    field: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct QuestionInput {
    /// The question text.
    pub question: String,
    /// Answer choices; use `{label, description}` objects.
    pub options: Vec<OptionItem>,
    /// If true, the user may tick several options (select all that apply).
    #[serde(default)]
    pub allow_multiple: bool,
    /// Suggested label for this question. That option is listed first.
    #[serde(default)]
    pub recommended: Option<String>,
    /// Also give a free-text Other field (default true).
    #[serde(default = "default_true")]
    pub allow_custom_answer: bool,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct CardsParams {
    /// Optional headline shown above the card.
    #[serde(default)]
    pub title: Option<String>,
    /// One or more questions shown as Grok-style option cards.
    #[serde(default)]
    pub questions: Vec<QuestionInput>,
    /// A single question. For several questions, use `questions` instead.
    #[serde(default)]
    pub question: Option<String>,
    /// Choices for a single `question`.
    #[serde(default)]
    pub options: Vec<OptionItem>,
    /// If true, the user may select several options for a single `question`.
    #[serde(default)]
    pub allow_multiple: bool,
    /// Suggested label for a single `question`. Listed first.
    #[serde(default)]
    pub recommended: Option<String>,
    /// Other field for a single `question` (default true).
    #[serde(default = "default_true")]
    pub allow_custom_answer: bool,
    /// Add one global free-text notes field. Optional Instructions is always shown.
    #[serde(default)]
    pub notes_field: bool,
}

impl CardsParams {
    fn into_questions(self) -> Vec<QuestionInput> {
        let mut questions = self.questions;
        if let Some(question) = self.question {
            if !self.options.is_empty() {
                questions.insert(
                    0,
                    QuestionInput {
                        question,
                        options: self.options,
                        allow_multiple: self.allow_multiple,
                        recommended: self.recommended,
                        allow_custom_answer: self.allow_custom_answer,
                    },
                );
            }
        }
        questions
    }
}

#[derive(Debug)]
struct QuestionMeta {
    question: String,
    multi: bool,
    opts: Vec<AskOption>,
    key: Option<String>,
    other_key: Option<String>,
}

#[derive(Debug)]
struct BuiltForm {
    message: String,
    schema: ElicitationSchema,
    meta: Vec<QuestionMeta>,
}

/// Ask User MCP server: Grok-style multiple-choice questions via MCP elicitation.
#[derive(Clone)]
pub struct AskUserServer {
    tool_router: ToolRouter<Self>,
    instructions: String,
}

impl Default for AskUserServer {
    fn default() -> Self {
        Self::new()
    }
}

#[tool_router(router = tool_router)]
impl AskUserServer {
    pub fn new() -> Self {
        let instructions = formatdoc! {r#"
            Use ask_user_cards whenever requirements are ambiguous or a decision is needed from the USER.
            It shows Grok-style in-chat option cards. Pass question+options for one question, or
            questions for a batch. Set allow_multiple so the user can tick several options. Other
            is on by default so they can add extra detail. Put the option you think is best in
            recommended — that choice is listed first and marked Recommended. For yes/no, pass Yes
            and No as options. If the user declines or skips, proceed with your best judgment.
            "#};

        Self {
            tool_router: Self::tool_router(),
            instructions,
        }
    }

    #[tool(
        name = "ask_user_cards",
        description = "Show the USER a Grok-style in-chat questionnaire: clickable option cards under each question (single-select picks one; set allow_multiple so they can tick several), Recommended listed first, per-question Other for extra detail, Submit/Skip. Use whenever requirements are ambiguous or a decision is needed. Pass question+options for one question, or questions for a batch. WAITS for Submit/Skip. If the user declines or skips, proceed with your best judgment. For yes/no, pass Yes and No as options.",
        annotations(read_only_hint = true, open_world_hint = false)
    )]
    async fn ask_user_cards(
        &self,
        Parameters(params): Parameters<CardsParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let notes_field = params.notes_field;
        let title = params.title.clone();
        let questions = params.into_questions();
        let what = if questions.len() > 1 {
            "questionnaire"
        } else {
            "question"
        };
        elicit_form(
            context,
            title,
            questions,
            notes_field,
            what,
            "ask_user_cards",
        )
        .await
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for AskUserServer {
    fn get_info(&self) -> ServerConfig {
        InitializeResult::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new(
                "goose-askuser",
                env!("CARGO_PKG_VERSION"),
            ))
            .with_instructions(self.instructions.clone())
    }
}

async fn elicit_form(
    context: RequestContext<RoleServer>,
    title: Option<String>,
    questions: Vec<QuestionInput>,
    notes_field: bool,
    what: &str,
    tool_name: &str,
) -> Result<CallToolResult, ErrorData> {
    let built = match build_form(title, questions, notes_field) {
        Ok(built) => built,
        Err(error) => {
            return Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "{tool_name} invalid input: {error}"
            ))]));
        }
    };

    let summary: String = (1..=built.meta.len())
        .map(|i| format!("Q{i}"))
        .collect::<Vec<_>>()
        .join(", ");

    let result = match context
        .peer
        .create_elicitation(ElicitRequestParams::FormElicitationParams {
            meta: None,
            message: built.message,
            requested_schema: built.schema,
        })
        .await
    {
        Ok(result) => result,
        Err(error) => {
            return Ok(CallToolResult::success(vec![ContentBlock::text(format!(
                "The {what} was cancelled/dismissed without an answer. ({error})\nQuestions: {summary}"
            ))]));
        }
    };

    let text = match result.action {
        ElicitationAction::Decline => format!(
            "User DECLINED to answer the {what}.\nQuestions: {summary}"
        ),
        ElicitationAction::Cancel => {
            format!("The {what} was cancelled/dismissed without an answer.\nQuestions: {summary}")
        }
        ElicitationAction::Accept => {
            let content = result.content.unwrap_or_else(|| serde_json::json!({}));
            render_answers(&built.meta, &content, notes_field, what)
        }
        _ => format!("The {what} was cancelled/dismissed without an answer.\nQuestions: {summary}"),
    };
    Ok(CallToolResult::success(vec![ContentBlock::text(text)]))
}

fn collapse_ws(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn short_name(text: &str, used: &mut HashMap<String, usize>) -> String {
    let mut name = collapse_ws(text);
    if name.chars().count() > MAX_NAME_LEN {
        let mut truncated = String::new();
        for ch in name.chars().take(MAX_NAME_LEN - 1) {
            truncated.push(ch);
        }
        name = truncated.trim_end().to_string();
        name.push('…');
    }
    let n = used.get(&name).copied().unwrap_or(0);
    used.insert(name.clone(), n + 1);
    if n == 0 {
        name
    } else {
        format!("{} ({})", name, n + 1)
    }
}

fn norm_options(raw: Vec<OptionItem>) -> Vec<AskOption> {
    raw.into_iter().filter_map(OptionItem::into_option).collect()
}

fn dedupe_labels(opts: Vec<AskOption>) -> Vec<AskOption> {
    let mut seen: HashMap<String, usize> = HashMap::new();
    opts.into_iter()
        .map(|mut o| {
            let n = seen.get(&o.label).copied().unwrap_or(0);
            seen.insert(o.label.clone(), n + 1);
            if n > 0 {
                o.label = format!("{} ({})", o.label, n + 1);
            }
            o
        })
        .collect()
}

fn match_recommended_label(opts: &[AskOption], recommended: Option<&str>) -> String {
    let rec = recommended.unwrap_or("").trim();
    if rec.is_empty() {
        return String::new();
    }
    if let Some(found) = opts.iter().find(|o| o.label == rec) {
        return found.label.clone();
    }
    let rec_l = rec.to_lowercase();
    if let Some(found) = opts.iter().find(|o| o.label.to_lowercase() == rec_l) {
        return found.label.clone();
    }
    rec.to_string()
}

fn put_recommended_first(mut opts: Vec<AskOption>, recommended: &str) -> Vec<AskOption> {
    if recommended.is_empty() {
        return opts;
    }
    if let Some(idx) = opts.iter().position(|o| o.label == recommended) {
        if idx > 0 {
            let rec = opts.remove(idx);
            opts.insert(0, rec);
        }
    }
    opts
}

fn order_options(opts: Vec<AskOption>, recommended: Option<&str>) -> (Vec<AskOption>, String) {
    let rec = match_recommended_label(&opts, recommended);
    let opts = put_recommended_first(opts, &rec);
    (opts, rec)
}

fn other_field_label(q_text: &str) -> String {
    const PREFIX: &str = "Other (for: ";
    const SUFFIX: &str = ")";
    let overhead = PREFIX.chars().count() + SUFFIX.chars().count();
    let budget = MAX_NAME_LEN.saturating_sub(overhead);
    let inner = collapse_ws(q_text);
    let inner = if inner.chars().count() > budget {
        let keep = budget.saturating_sub(1);
        let mut truncated: String = inner.chars().take(keep).collect();
        truncated = truncated.trim_end().to_string();
        truncated.push('…');
        truncated
    } else {
        inner
    };
    format!("{PREFIX}{inner}{SUFFIX}")
}

fn add_other_field(
    q_text: &str,
    used: &mut HashMap<String, usize>,
    properties: &mut BTreeMap<String, PrimitiveSchemaDefinition>,
    order: &mut Vec<String>,
) -> Option<String> {
    let other_key = short_name(&other_field_label(q_text), used);
    properties.insert(
        other_key.clone(),
        PrimitiveSchemaDefinition::String(
            StringSchema::new().description("Free text if none of the options fit. Optional."),
        ),
    );
    order.push(other_key.clone());
    Some(other_key)
}

fn option_bullets(opts: &[AskOption]) -> String {
    opts.iter()
        .map(|o| {
            if o.description.is_empty() {
                format!("• {}", o.label)
            } else {
                format!("• {} — {}", o.label, o.description)
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn build_question_fields(
    q: QuestionInput,
    used: &mut HashMap<String, usize>,
    properties: &mut BTreeMap<String, PrimitiveSchemaDefinition>,
    order: &mut Vec<String>,
) -> Result<QuestionMeta, String> {
    let q_text = collapse_ws(&q.question);
    if q_text.is_empty() {
        return Err("question text is empty".to_string());
    }
    let opts = dedupe_labels(norm_options(q.options));
    if opts.len() < 2 {
        return Err("need at least one valid question with >= 2 options".to_string());
    }
    if opts.len() > MAX_OPTIONS {
        return Err(format!("at most {MAX_OPTIONS} options per question"));
    }
    let (opts, rec) = order_options(opts, q.recommended.as_deref());
    let multi = q.allow_multiple;

    if multi {
        let mut field_opts = Vec::new();
        for o in opts {
            let fld = short_name(&o.label, used);
            let desc = if o.description.is_empty() {
                format!("Option of: {q_text}")
            } else {
                format!("Option of: {q_text} — {}", o.description)
            };
            properties.insert(
                fld.clone(),
                PrimitiveSchemaDefinition::Boolean(BooleanSchema::new().description(desc)),
            );
            order.push(fld.clone());
            field_opts.push(AskOption {
                label: o.label,
                description: o.description,
                field: fld,
            });
        }
        let other_key = add_other_field(&q_text, used, properties, order);
        return Ok(QuestionMeta {
            question: q_text,
            multi: true,
            opts: field_opts,
            key: None,
            other_key,
        });
    }

    let mut q_desc = q_text.clone();
    if !rec.is_empty() {
        q_desc.push_str("\n(Suggested: ");
        q_desc.push_str(&rec);
        q_desc.push(')');
    }
    q_desc.push_str("\nChoose one:\n");
    q_desc.push_str(&option_bullets(&opts));

    let key = short_name(&q_text, used);
    let labels: Vec<String> = opts.iter().map(|o| o.label.clone()).collect();
    let mut enum_schema = LegacyEnumSchema::new(labels);
    enum_schema.description = Some(Cow::Owned(q_desc));
    properties.insert(
        key.clone(),
        PrimitiveSchemaDefinition::Enum(EnumSchema::Legacy(enum_schema)),
    );
    order.push(key.clone());

    let other_key = add_other_field(&q_text, used, properties, order);

    Ok(QuestionMeta {
        question: q_text,
        multi: false,
        opts,
        key: Some(key),
        other_key,
    })
}

fn build_form(
    title: Option<String>,
    questions: Vec<QuestionInput>,
    _notes_field: bool,
) -> Result<BuiltForm, String> {
    if questions.is_empty() {
        return Err("need at least one valid question with >= 2 options".to_string());
    }
    if questions.len() > MAX_QUESTIONS {
        return Err(format!("at most {MAX_QUESTIONS} questions"));
    }

    let mut properties = BTreeMap::new();
    let mut order = Vec::new();
    let mut used = HashMap::new();
    let mut meta = Vec::new();
    let mut titles = Vec::new();

    for q in questions {
        titles.push(collapse_ws(&q.question));
        meta.push(build_question_fields(
            q,
            &mut used,
            &mut properties,
            &mut order,
        )?);
    }

    properties.insert(
        KEY_NOTE.to_string(),
        PrimitiveSchemaDefinition::String(StringSchema::new().description(
            "OPTIONAL: extra context, constraints, or comments.",
        )),
    );
    order.push(KEY_NOTE.to_string());

    let mut schema = ElicitationSchema::new(properties);
    schema.property_order = Some(order);

    let headline = title
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("I need a few decisions from you before I proceed:");
    let mut message = headline.to_string();
    for (i, t) in titles.iter().enumerate() {
        message.push_str(&format!("\n\n{}) {}", i + 1, t));
    }

    Ok(BuiltForm {
        message,
        schema,
        meta,
    })
}

fn content_str(content: &serde_json::Value, key: &str) -> String {
    content
        .get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

fn content_true(content: &serde_json::Value, key: &str) -> bool {
    content.get(key).and_then(|v| v.as_bool()) == Some(true)
}

fn render_answers(
    meta: &[QuestionMeta],
    content: &serde_json::Value,
    _notes_field: bool,
    what: &str,
) -> String {
    let mut lines = Vec::new();
    let mut answered = 0usize;
    for (i, m) in meta.iter().enumerate() {
        let other = m
            .other_key
            .as_deref()
            .map(|k| content_str(content, k))
            .unwrap_or_default();
        let also = if other.is_empty() {
            String::new()
        } else {
            format!(" — also typed: {other}")
        };

        if !m.multi {
            let choice = m
                .key
                .as_deref()
                .map(|k| content_str(content, k))
                .unwrap_or_default();
            let labels: Vec<&str> = m.opts.iter().map(|o| o.label.as_str()).collect();
            if labels.iter().any(|l| *l == choice) {
                lines.push(format!(
                    "[{}] {}\n    Answer: {}{}",
                    i + 1,
                    m.question,
                    choice,
                    also
                ));
                answered += 1;
            } else if !other.is_empty() {
                lines.push(format!(
                    "[{}] {}\n    Custom answer: {}",
                    i + 1,
                    m.question,
                    other
                ));
                answered += 1;
            } else {
                lines.push(format!("[{}] {}\n    No answer (skipped).", i + 1, m.question));
            }
        } else {
            let chosen: Vec<&str> = m
                .opts
                .iter()
                .filter(|o| content_true(content, &o.field))
                .map(|o| o.label.as_str())
                .collect();
            if !chosen.is_empty() {
                lines.push(format!(
                    "[{}] {}\n    Selected: {}{}",
                    i + 1,
                    m.question,
                    chosen.join(", "),
                    also
                ));
                answered += 1;
            } else if !other.is_empty() {
                lines.push(format!(
                    "[{}] {}\n    Custom answer: {}",
                    i + 1,
                    m.question,
                    other
                ));
                answered += 1;
            } else {
                lines.push(format!(
                    "[{}] {}\n    Nothing selected (skipped).",
                    i + 1,
                    m.question
                ));
            }
        }
    }

    let head = if what == "questionnaire" {
        format!(
            "User answered the questionnaire ({}/{} answered):",
            answered,
            meta.len()
        )
    } else {
        "User answered the question:".to_string()
    };
    let mut out = format!("{head}\n{}", lines.join("\n"));
    let notes = content_str(content, KEY_NOTE);
    if !notes.is_empty() {
        out.push_str("\nOptional instructions: ");
        out.push_str(&notes);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obj(label: &str, description: &str) -> OptionItem {
        OptionItem::Object {
            label: label.to_string(),
            description: Some(description.to_string()),
        }
    }

    fn label(s: &str) -> OptionItem {
        OptionItem::Label(s.to_string())
    }

    fn q(question: &str, options: Vec<OptionItem>, recommended: Option<&str>) -> QuestionInput {
        QuestionInput {
            question: question.to_string(),
            options,
            allow_multiple: false,
            recommended: recommended.map(str::to_string),
            allow_custom_answer: true,
        }
    }

    #[test]
    fn recommended_option_is_first_in_enum() {
        let built = build_form(
            None,
            vec![q(
                "How would you prefer I work with you?",
                vec![
                    obj("Ask before acting", "Check in with you first"),
                    obj("Act autonomously", "Proceed on your own"),
                ],
                Some("Act autonomously"),
            )],
            false,
        )
        .unwrap();

        let json = serde_json::to_value(&built.schema).unwrap();
        let enum_vals = json["properties"]["How would you prefer I work with you?"]["enum"]
            .as_array()
            .unwrap();
        assert_eq!(enum_vals[0], "Act autonomously");
        assert_eq!(enum_vals[1], "Ask before acting");

        let desc = json["properties"]["How would you prefer I work with you?"]["description"]
            .as_str()
            .unwrap();
        assert!(desc.contains("(Suggested: Act autonomously)"));
        let rec_bullet = desc.find("• Act autonomously").unwrap();
        let other_bullet = desc.find("• Ask before acting").unwrap();
        assert!(rec_bullet < other_bullet);
    }

    #[test]
    fn recommended_match_is_case_insensitive() {
        let built = build_form(
            None,
            vec![q(
                "Pick a color",
                vec![label("Red"), label("Blue")],
                Some("blue"),
            )],
            false,
        )
        .unwrap();
        let json = serde_json::to_value(&built.schema).unwrap();
        assert_eq!(json["properties"]["Pick a color"]["enum"][0], "Blue");
        let desc = json["properties"]["Pick a color"]["description"]
            .as_str()
            .unwrap();
        assert!(desc.contains("(Suggested: Blue)"));
    }

    #[test]
    fn unmatched_recommended_keeps_input_order() {
        let built = build_form(
            None,
            vec![q(
                "Pick a color",
                vec![label("Red"), label("Blue")],
                Some("Green"),
            )],
            false,
        )
        .unwrap();
        let json = serde_json::to_value(&built.schema).unwrap();
        assert_eq!(json["properties"]["Pick a color"]["enum"][0], "Red");
        assert_eq!(json["properties"]["Pick a color"]["enum"][1], "Blue");
    }

    #[test]
    fn multi_select_recommended_is_first_property() {
        let mut question = q(
            "How mandatory?",
            vec![label("Every account"), label("Admins only"), label("Optional")],
            Some("Optional"),
        );
        question.allow_multiple = true;
        let built = build_form(None, vec![question], false).unwrap();
        assert_eq!(
            built.schema.property_order.as_ref().unwrap()[0],
            "Optional"
        );
        assert_eq!(built.meta[0].opts[0].label, "Optional");
        assert_eq!(built.meta[0].opts[1].label, "Every account");
    }

    #[test]
    fn property_order_keeps_other_after_question() {
        let built = build_form(
            None,
            vec![q("Q?", vec![label("A"), label("B")], None)],
            false,
        )
        .unwrap();
        assert_eq!(
            built.schema.property_order.as_deref(),
            Some(
                [
                    "Q?".to_string(),
                    "Other (for: Q?)".to_string(),
                    KEY_NOTE.to_string()
                ]
                .as_slice()
            )
        );
    }

    #[test]
    fn other_key_keeps_closing_paren_for_long_question() {
        let question = "2. If you could automate one annoying chore today, which one?";
        let built = build_form(
            None,
            vec![q(question, vec![label("Email"), label("File chaos")], None)],
            false,
        )
        .unwrap();
        let other = built
            .schema
            .property_order
            .as_ref()
            .unwrap()
            .iter()
            .find(|key| key.starts_with("Other (for:"))
            .expect("other field");
        assert!(other.ends_with(')'));
        assert!(other.chars().count() <= MAX_NAME_LEN);
        assert!(other.starts_with("Other (for: "));
    }

    #[test]
    fn rejects_single_option() {
        let err = build_form(None, vec![q("Q?", vec![label("A")], None)], false).unwrap_err();
        assert!(err.contains(">= 2 options"));
    }
}
