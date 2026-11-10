import wasm from "./wasm.mjs";
import { browserOptions } from "./client.mjs";
import "./styles.css";

wasm.mount(browserOptions());
