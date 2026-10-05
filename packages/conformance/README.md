# @ffp/conformance (private)

Shared conformance test vectors (`vectors/*.json`, 185 evaluation cases + 24 hash vectors) and a runner used by the evaluator (Node and Chromium), `@ashamrai/flags-node`, `@ashamrai/flags-web` (Chromium, through the relay) and the relay's server-side evaluation. Bucket expectations were computed with an independent C implementation of murmurhash3_x86_32, not with the TypeScript code under test.
