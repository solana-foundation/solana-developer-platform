//! A request's steps. A flow implementation lists its steps, which the service reads from the
//! decompiled document. Any other request is one step that holds every intent.

use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::error::ServiceError;
use crate::intents::progress::Progress;

/// The name of the one step of a request that is not a flow.
pub const ONLY_STEP: &str = "1";

#[derive(Clone, Debug, Deserialize)]
pub struct FlowStep {
    pub name: String,
    pub intent: StepIntent,
    #[serde(default)]
    pub ready: Option<Map<String, Value>>,
    #[serde(default)]
    pub done: Option<Map<String, Value>>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct StepIntent {
    pub interface: String,
    #[serde(default)]
    pub implementation: Option<String>,
    pub inputs: Map<String, Value>,
}

/// The steps of a request: a flow's, or the request itself as one step.
pub enum Steps {
    Single,
    Flow(Vec<FlowStep>),
}

impl Steps {
    pub fn names(&self) -> Vec<&str> {
        match self {
            Self::Single => vec![ONLY_STEP],
            Self::Flow(steps) => steps.iter().map(|step| step.name.as_str()).collect(),
        }
    }

    pub fn condition(&self, position: usize, which: Which) -> Option<&Map<String, Value>> {
        let Self::Flow(steps) = self else {
            return None;
        };
        let step = steps.get(position)?;

        match which {
            Which::Ready => step.ready.as_ref(),
            Which::Done => step.done.as_ref(),
        }
    }
}

#[derive(Clone, Copy)]
pub enum Which {
    Ready,
    Done,
}

/// Values for the references of a flow: the outer intent's inputs, the request's payers, and the
/// facts of the steps that `progress` holds.
pub struct Bindings<'p> {
    pub progress: &'p Progress,
}

impl Bindings<'_> {
    fn intent(&self) -> Option<&Value> {
        self.progress.request.pointer("/intents/0")
    }

    /// The value of a string that is exactly one reference, or `None` for any other string.
    pub fn value(&self, text: &str) -> Option<Value> {
        let inner = text.strip_prefix('{')?.strip_suffix('}')?;
        let mut parts = inner.split('.');

        match (parts.next()?, parts.next()?, parts.next(), parts.next()) {
            ("inputs", name, None, None) => self.intent()?.pointer(&format!("/inputs/{name}")).cloned(),
            ("payers", name, None, None) => self.progress.request.pointer(&format!("/payers/{name}")).cloned(),
            ("steps", step, Some("plan"), Some("nullifiers")) => {
                let nullifiers = self.progress.steps.get(step).map(|record| record.plan.nullifiers.clone());

                Some(json!(nullifiers.unwrap_or_default()))
            }
            _ => None,
        }
    }

    /// The JSON with each reference replaced by its value.
    pub fn bind(&self, value: &Value) -> Result<Value, ServiceError> {
        match value {
            Value::String(text) if text.starts_with('{') && text.ends_with('}') => self
                .value(text)
                .ok_or_else(|| ServiceError::refused("flow", format!("`{text}` names no value of the flow"))),
            Value::Object(map) => {
                Ok(Value::Object(map.iter().map(|(key, item)| Ok((key.clone(), self.bind(item)?))).collect::<Result<
                    _,
                    ServiceError,
                >>(
                )?))
            }
            other => Ok(other.clone()),
        }
    }

    /// A template with each `{inputs.x}` and `{payers.x}` replaced by its value.
    pub fn render(&self, template: &str) -> String {
        let mut rendered = String::with_capacity(template.len());
        let mut rest = template;

        while let Some(start) = rest.find('{') {
            let (text, from_brace) = rest.split_at(start);
            rendered.push_str(text);
            let end = from_brace.find('}').map_or(from_brace.len(), |end| end.saturating_add(1));
            let (reference, after) = from_brace.split_at(end);
            let value = self.value(reference);
            rendered.push_str(&value.as_ref().and_then(Value::as_str).map_or(reference.to_owned(), str::to_owned));
            rest = after;
        }

        rendered.push_str(rest);
        rendered
    }

    /// The plan request of one step: the outer request with the step's intent, at the pinned
    /// versions, and the outer intent's options.
    pub fn step_request(&self, step: &FlowStep) -> Result<String, ServiceError> {
        let range = |range: &str| -> String {
            let id = range.split_once('@').map_or(range, |(id, _)| id);

            self.progress.pinned(id).map_or_else(|| range.to_owned(), str::to_owned)
        };
        let inputs = self.bind(&Value::Object(step.intent.inputs.clone()))?;
        let mut intent = json!({ "interface": range(&step.intent.interface), "inputs": inputs });

        if let (Some(implementation), Some(object)) = (&step.intent.implementation, intent.as_object_mut()) {
            object.insert("implementation".to_owned(), Value::from(range(implementation)));
        }

        if let (Some(options), Some(object)) =
            (self.intent().and_then(|outer| outer.get("options")), intent.as_object_mut())
        {
            object.insert("options".to_owned(), options.clone());
        }

        let mut request = self.progress.request.clone();
        if let Some(object) = request.as_object_mut() {
            object.insert("intents".to_owned(), json!([intent]));
        }

        Ok(request.to_string())
    }
}
