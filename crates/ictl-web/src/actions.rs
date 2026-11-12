use crate::js::*;
use js_sys::Promise;
use std::{cell::RefCell, collections::HashMap, rc::Rc};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::future_to_promise;
struct Actions {
    client: JsValue,
    options: JsValue,
    in_flight: Option<(JsValue, u64)>,
    next_run: u64,
    stops: HashMap<String, Promise>,
}
impl Actions {
    fn notify(&self, key: &str, value: JsValue) {
        let _ = apply(&get(&self.options, key), &JsValue::UNDEFINED, &[value]);
    }
    fn session(&self) -> JsValue {
        get(&call(&self.client, "snapshot", &[]).unwrap_or_default(), "session")
    }
    fn current(&self, session: &JsValue, task: &JsValue) -> bool {
        let s = self.session();
        get(&s, "id") == *session && get(&get(&s, "task"), "id") == *task
    }
    fn publish_stop(&self) {
        let session = self.session();
        let key = format!("{}/{}", text(&session, "id"), text(&get(&session, "task"), "id"));
        self.notify("onStopBusy", if self.stops.contains_key(&key) { key.into() } else { JsValue::NULL });
    }
}
#[wasm_bindgen(js_name=createTaskActions)]
pub fn create_task_actions(client: JsValue, options: JsValue) -> JsValue {
    let state = Rc::new(RefCell::new(Actions { client, options, in_flight: None, next_run: 0, stops: HashMap::new() }));
    let run_state = state.clone();
    let run = callback(move |operation| {
        let (options, client, session, epoch) = {
            let mut s = run_state.borrow_mut();
            let session = get(&s.session(), "id");
            if s.in_flight.as_ref().is_some_and(|(id, _)| *id == session) {
                return Promise::resolve(&JsValue::UNDEFINED).into();
            }
            s.next_run += 1;
            let epoch = s.next_run;
            s.in_flight = Some((session.clone(), epoch));
            (s.options.clone(), s.client.clone(), session, epoch)
        };
        let _ = apply(&get(&options, "onBusy"), &JsValue::UNDEFINED, &[true.into()]);
        let _ = apply(&get(&options, "onError"), &JsValue::UNDEFINED, &["".into()]);
        let result = apply(&operation, &JsValue::UNDEFINED, &[]);
        let state = run_state.clone();
        future_to_promise(async move {
            let result = match result {
                Ok(value) => resolved(value).await,
                Err(e) => Err(e),
            };
            let result = if result.is_ok() && get(&state.borrow().session(), "id") == session {
                invoke(&client, "refresh", &[]).await
            } else {
                result
            };
            if let Err(e) = result
                && get(&state.borrow().session(), "id") == session
            {
                let _ = apply(&get(&options, "onError"), &JsValue::UNDEFINED, &[message(&e).into()]);
            }
            if state.borrow().in_flight.as_ref().is_some_and(|(_, active)| *active == epoch) {
                state.borrow_mut().in_flight = None;
                let _ = apply(&get(&options, "onBusy"), &JsValue::UNDEFINED, &[false.into()]);
            }
            Ok(JsValue::UNDEFINED)
        })
        .into()
    });
    let stop = callback2(move |session, task| {
        let key = format!("{}/{}", session.as_string().unwrap_or_default(), task.as_string().unwrap_or_default());
        {
            let s = state.borrow();
            if !s.current(&session, &task) {
                return Promise::resolve(&JsValue::UNDEFINED).into();
            }
            if let Some(pending) = s.stops.get(&key) {
                return pending.clone().into();
            }
            if ["completed", "failed", "stopped"].contains(&text(&get(&s.session(), "task"), "state").as_str()) {
                return Promise::resolve(&JsValue::UNDEFINED).into();
            }
            s.notify("onError", "".into());
        }
        let owner = state.clone();
        let pending_key = key.clone();
        let client = state.borrow().client.clone();
        let request = call(&client, "stopTask", std::slice::from_ref(&task));
        let pending = future_to_promise(async move {
            let result = match request {
                Ok(v) => resolved(v).await,
                Err(e) => Err(e),
            };
            if let Err(e) = result {
                let s = owner.borrow();
                if s.current(&session, &task) {
                    s.notify("onError", message(&e).into());
                }
            }
            owner.borrow_mut().stops.remove(&pending_key);
            owner.borrow().publish_stop();
            Ok(JsValue::UNDEFINED)
        });
        state.borrow_mut().stops.insert(key, pending.clone());
        state.borrow().publish_stop();
        pending.into()
    });
    obj(&[("run", run), ("stop", stop)])
}
