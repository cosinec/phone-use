#[derive(Default)]
pub struct PacketBuffer {
    bytes: Vec<u8>,
}
impl PacketBuffer {
    pub fn push(&mut self, bytes: &[u8]) -> Result<(), &'static str> {
        if self.bytes.len() + bytes.len() > 131072 {
            return Err("USB receive buffer exceeded");
        }
        self.bytes.extend_from_slice(bytes);
        Ok(())
    }
    pub fn packet(&mut self) -> Result<Option<Vec<u8>>, &'static str> {
        if self.bytes.len() < 8 {
            return Ok(None);
        }
        let length = u32::from_be_bytes(self.bytes[4..8].try_into().unwrap()) as usize;
        if !(8..=65536).contains(&length) {
            return Err("Invalid usbmux packet length");
        }
        if self.bytes.len() < length {
            return Ok(None);
        }
        Ok(Some(self.bytes.drain(..length).collect()))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fragmented_and_coalesced_packets_are_preserved() {
        let mut buffer = PacketBuffer::default();
        buffer.push(&[0, 0, 0]).unwrap();
        assert_eq!(buffer.packet().unwrap(), None);
        buffer.push(&[0, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0, 8]).unwrap();
        assert_eq!(buffer.packet().unwrap().unwrap().len(), 8);
        assert_eq!(buffer.packet().unwrap().unwrap().len(), 8);
        assert!(buffer.packet().unwrap().is_none());
    }
}
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen(js_name=completeUsbPacketReads)]
pub fn complete_usb_packet_reads(
    device: wasm_bindgen::JsValue,
) -> Result<wasm_bindgen::JsValue, wasm_bindgen::JsValue> {
    use crate::js::*;
    use std::{cell::RefCell, collections::HashMap, rc::Rc};
    use wasm_bindgen::JsCast;
    let endpoints = Rc::new(RefCell::new(HashMap::<u32, PacketBuffer>::new()));
    let target = device.clone();
    let read = callback2(move |endpoint, length| {
        let buffers = endpoints.clone();
        let device = target.clone();
        let endpoint_number = endpoint.as_f64().unwrap_or(0.0) as u32;
        wasm_bindgen_futures::future_to_promise(async move {
            loop {
                let packet = buffers.borrow_mut().entry(endpoint_number).or_default().packet().map_err(error)?;
                if let Some(packet) = packet {
                    let bytes = js_sys::Uint8Array::from(packet.as_slice());
                    let data = js_sys::DataView::new(&bytes.buffer(), 0, bytes.length() as usize);
                    return Ok(obj(&[("status", "ok".into()), ("data", data.into())]));
                }
                let result = invoke(&device, "transferIn", &[endpoint.clone(), length.clone()]).await?;
                let data = get(&result, "data");
                if text(&result, "status") != "ok" || !truth(&data) {
                    return Ok(result);
                }
                let bytes = js_sys::Uint8Array::new_with_byte_offset_and_length(
                    &get(&data, "buffer").unchecked_into(),
                    number(&data, "byteOffset") as u32,
                    number(&data, "byteLength") as u32,
                )
                .to_vec();
                buffers.borrow_mut().entry(endpoint_number).or_default().push(&bytes).map_err(error)?;
            }
        })
        .into()
    });
    let get = callback2(move |target, key| {
        if key.as_string().as_deref() == Some("transferIn") {
            return read.clone();
        }
        let value = js_sys::Reflect::get(&target, &key).unwrap_or_default();
        if value.is_function() { call(&value, "bind", &[target]).unwrap_or_default() } else { value }
    });
    Ok(js_sys::Proxy::new(&device, &js_sys::Object::from(obj(&[("get", get)]))).into())
}
