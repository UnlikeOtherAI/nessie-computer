# T3 Code reference

Computer resource sampling, native account/quota windows and saved-history
behavior were informed by [T3 Code](https://github.com/pingdotgg/t3code/tree/6577c6b6185167c0e502fa01f9e8e8f2dee6ff25).
The executor uses its own protocol, lifecycle, custody and authorization code.
Additional provider quota contracts follow [T3 Code commit 25bf84ab](https://github.com/pingdotgg/t3code/tree/25bf84ab07f53f141c20239c63e383823a9d5ea0),
as catalogued in [provider quota sources](docs/provider-quotas.md).

Pinned session-engine source preparation also references T3 Code revision
`25bf84ab07f53f141c20239c63e383823a9d5ea0`; see `docs/session-engine.md`.
Its offline source capsule and derived lower-state library candidates retain
the original MIT LICENSE, with notices for bundled runtime dependencies. This
work does not yet ship or start the T3 session runtime in an installed executor.

MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
