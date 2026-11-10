import wasm from './wasm.mjs';
import * as sdk from '@limrun/device-install';
import * as androidSdk from './android/bridge.mjs';
export const browserOptions = () => ({sdk, androidSdk});
export class BrowserClient extends wasm.BrowserClient {
  constructor(options = {}) {
    super({...browserOptions(), ...options});
    this.snapshot = this.snapshot.bind(this);
    this.subscribe = this.subscribe.bind(this);
  }
}
