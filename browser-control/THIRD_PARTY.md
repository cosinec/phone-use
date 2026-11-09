# Browser/cloud third-party components

Project additions are covered by the repository [MIT license](../LICENSE). Existing native components, MPL-2.0 source obligations, Appium BSD-3-Clause WDA and native notices remain described in the original [THIRD_PARTY.md](../THIRD_PARTY.md) and [licensing guide](../docs/licensing.md). The Docker image copies the unchanged native image's `/usr/share/licenses` and `/usr/share/doc/iphone-control`, including `THIRD_PARTY_LICENSES.html`, plus its unsigned WDA resource.

| Component | Pinned version/source | License/reuse |
|---|---|---|
| [@limrun/device-install](https://www.npmjs.com/package/@limrun/device-install/v/0.1.0) | 0.1.0; installed package metadata | MIT as declared by this published package; imported public USB chooser, pairing, relay close and IndexedDB store APIs. No USB protocol code copied or changed. |
| [iphone-control PR #34](https://github.com/Derrors/iphone-control/pull/34) | commit [ff78e757](https://github.com/Derrors/iphone-control/commit/ff78e757) | MIT; `web/interaction.mjs` adapts object-fit screenshot coordinate conversion and pointer tap/swipe/long-press behavior. Copyright (c) 2026 iphone-control contributors. |
| React / React DOM | 19.2.6 | MIT, Copyright (c) Meta Platforms, Inc. and affiliates; license files are retained in production node_modules. |
| ws | 8.22.2 | MIT; its own license is retained in production node_modules. |
| plist | 5.1.0 | MIT; its own and transitive dependency notices remain in production node_modules. |
| Vite / TypeScript / React plugin / type declarations | package-lock.json | Build-only dependencies retain their package licenses; omitted from runtime image. |

The published device-install package declares MIT and omits a LICENSE file in its npm tarball. The current [typescript-sdk repository root license](https://github.com/limrun-inc/typescript-sdk/blob/main/LICENSE) is Apache-2.0 (Copyright 2026 Limrun). This report distinguishes published artifact metadata from the repository's license; it does not describe the entire upstream repository as MIT. Upstream licensing clarification should accompany redistribution beyond this source implementation.

MIT permission text (published package metadata and adapted MIT interaction code):

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.
