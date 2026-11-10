import { WebCodecsVideoDecoder } from '@yume-chan/scrcpy-decoder-webcodecs';
import { WritableStream } from '@yume-chan/stream-extra';
import wasm from '../wasm.mjs';
export const {FrameMailbox, sameViewport} = wasm;
// Dependency construction stays in JS. Frame lifecycle and capture policy live in Rust.
export class AndroidVideoCapture extends wasm.AndroidVideoCapture {
  static get isSupported() {
    return WebCodecsVideoDecoder.isSupported && typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap === 'function';
  }
  constructor(options) {
    super({...options, decoderFactory: options => new WebCodecsVideoDecoder(options), streamFactory: sink => new WritableStream(sink)});
  }
}
