use crate::js::*;
use std::{cell::RefCell, rc::Rc};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::spawn_local;
struct Polling {
    client: JsValue,
    options: JsValue,
    session: JsValue,
    stopped: bool,
    timers: Vec<JsValue>,
}
impl Polling {
    fn current(&self) -> bool {
        !self.stopped
            && get(&get(&call(&self.client, "snapshot", &[]).unwrap_or_default(), "session"), "id") == self.session
    }
    fn ready(&self) -> bool {
        let session = get(&call(&self.client, "snapshot", &[]).unwrap_or_default(), "session");
        self.current()
            && truth(&get(&session, "ready"))
            && text(&get(&get(&session, "daemon"), "state"), "state") == "ready"
    }
}
fn later(state: Rc<RefCell<Polling>>, preview: bool) {
    if !state.borrow().current() {
        return;
    }
    let weak = Rc::downgrade(&state);
    let timer_id = Rc::new(RefCell::new(JsValue::UNDEFINED));
    let callback_id = timer_id.clone();
    let timer = callback(move |_| {
        if let Some(state) = weak.upgrade() {
            state.borrow_mut().timers.retain(|id| id != &*callback_id.borrow());
            tick(state, preview);
        }
        JsValue::UNDEFINED
    });
    let schedule = get(&state.borrow().options, "schedule");
    let schedule = if schedule.is_function() { schedule } else { get(&global(), "setTimeout") };
    let id = apply(&schedule, &global(), &[timer, if preview { 1800.0 } else { 1000.0 }.into()]).unwrap_or_default();
    *timer_id.borrow_mut() = id.clone();
    state.borrow_mut().timers.push(id);
}
fn tick(state: Rc<RefCell<Polling>>, preview: bool) {
    let client = state.borrow().client.clone();
    let request = if preview {
        if state.borrow().ready() {
            call(&client, "screen", &[])
        } else {
            later(state, preview);
            return;
        }
    } else {
        call(&client, "refresh", &[])
    };
    spawn_local(async move {
        let result = match request {
            Ok(v) => resolved(v).await,
            Err(e) => Err(e),
        };
        let options = state.borrow().options.clone();
        match result {
            Ok(image) => {
                if preview {
                    let device = get(&get(&call(&client, "snapshot", &[]).unwrap_or_default(), "session"), "deviceId");
                    if state.borrow().ready() && get(&image, "deviceId") == device {
                        let _ = apply(&get(&options, "onScreen"), &JsValue::UNDEFINED, &[image]);
                    }
                } else if state.borrow().current() && !state.borrow().ready() {
                    let _ = apply(&get(&options, "onScreen"), &JsValue::UNDEFINED, &[JsValue::NULL]);
                }
            }
            Err(e) => {
                if state.borrow().current() {
                    let _ = apply(&get(&options, "onError"), &JsValue::UNDEFINED, &[message(&e).into()]);
                }
            }
        }
        later(state, preview);
    });
}
#[wasm_bindgen(js_name=startSessionPolling)]
pub fn start_session_polling(client: JsValue, options: JsValue) -> JsValue {
    let session = get(&get(&call(&client, "snapshot", &[]).unwrap_or_default(), "session"), "id");
    let state = Rc::new(RefCell::new(Polling { client, options, session, stopped: false, timers: vec![] }));
    tick(state.clone(), false);
    tick(state.clone(), true);
    callback(move |_| {
        let timers = {
            let mut s = state.borrow_mut();
            s.stopped = true;
            std::mem::take(&mut s.timers)
        };
        let unschedule = get(&state.borrow().options, "unschedule");
        let unschedule = if unschedule.is_function() { unschedule } else { get(&global(), "clearTimeout") };
        for timer in timers {
            let _ = apply(&unschedule, &global(), &[timer]);
        }
        JsValue::UNDEFINED
    })
}
