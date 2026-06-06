<!--
  AUTO-GENERATED — DO NOT EDIT BY HAND.
  Regenerate with:  node scripts/generate-dependencies.mjs
  (run `npm ci` and have a Rust toolchain on PATH first).
-->

# Dependencies

License inventory of every third-party dependency Tessera builds
against or ships, generated from the toolchains' own metadata. See the
header comment of [`scripts/generate-dependencies.mjs`](../scripts/generate-dependencies.mjs)
for the exact data sources.

Reproduce:

```sh
node scripts/generate-dependencies.mjs
```

- **Rust crates:** 587 (from `cargo metadata --format-version 1 --all-features`, excluding the first-party workspace crates)
- **npm packages:** 880 (full installed `node_modules` tree, incl. transitive + dev)

## Rust — license summary

| License | Count |
| --- | --- |
| MIT OR Apache-2.0 | 270 |
| MIT | 101 |
| MIT/Apache-2.0 | 48 |
| Unicode-3.0 | 38 |
| Apache-2.0 OR MIT | 31 |
| Apache-2.0 | 19 |
| Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | 15 |
| Unlicense OR MIT | 7 |
| MIT OR Apache-2.0 OR Zlib | 6 |
| ISC | 5 |
| BSD-2-Clause | 4 |
| BSD-3-Clause | 4 |
| Unlicense/MIT | 4 |
| Zlib | 3 |
| Zlib OR Apache-2.0 OR MIT | 3 |
| Apache-2.0 OR ISC OR MIT | 2 |
| Apache-2.0 OR MIT OR Zlib | 2 |
| Apache-2.0 WITH LLVM-exception | 2 |
| Apache-2.0/MIT | 2 |
| BSD-2-Clause OR Apache-2.0 OR MIT | 2 |
| BSD-3-Clause OR Apache-2.0 | 2 |
| CDLA-Permissive-2.0 | 2 |
| MIT OR Apache-2.0 OR LGPL-2.1-or-later | 2 |
| MPL-2.0 | 2 |
| (Apache-2.0 OR MIT) AND BSD-3-Clause | 1 |
| (MIT OR Apache-2.0) AND Unicode-3.0 | 1 |
| 0BSD OR MIT OR Apache-2.0 | 1 |
| Apache-2.0 / MIT | 1 |
| Apache-2.0 AND ISC | 1 |
| Apache-2.0 OR BSL-1.0 | 1 |
| CC0-1.0 | 1 |
| CC0-1.0 OR Apache-2.0 OR Apache-2.0 WITH LLVM-exception | 1 |
| CC0-1.0 OR MIT-0 OR Apache-2.0 | 1 |
| MIT OR Apache-2.0 OR CC0-1.0 | 1 |
| MIT OR Zlib OR Apache-2.0 | 1 |

## npm — license summary

| License | Count |
| --- | --- |
| MIT | 666 |
| ISC | 106 |
| Apache-2.0 | 47 |
| BSD-2-Clause | 18 |
| BSD-3-Clause | 17 |
| BlueOak-1.0.0 | 10 |
| MIT-0 | 5 |
| (MIT OR CC0-1.0) | 2 |
| (MPL-2.0 OR Apache-2.0) | 1 |
| (WTFPL OR MIT) | 1 |
| 0BSD | 1 |
| CC-BY-4.0 | 1 |
| Python-2.0 | 1 |
| UNKNOWN | 1 |
| Unlicense | 1 |
| WTFPL | 1 |
| WTFPL OR ISC | 1 |

## Rust crates

| Package | Version | License | Repository |
| --- | --- | --- | --- |
| adler2 | 2.0.1 | 0BSD OR MIT OR Apache-2.0 | https://github.com/oyvindln/adler2 |
| aead | 0.5.2 | MIT OR Apache-2.0 | https://github.com/RustCrypto/traits |
| aes | 0.8.4 | MIT OR Apache-2.0 | https://github.com/RustCrypto/block-ciphers |
| aes-gcm | 0.10.3 | Apache-2.0 OR MIT | https://github.com/RustCrypto/AEADs |
| ahash | 0.8.12 | MIT OR Apache-2.0 | https://github.com/tkaitchuck/ahash |
| aho-corasick | 1.1.4 | Unlicense OR MIT | https://github.com/BurntSushi/aho-corasick |
| android_system_properties | 0.1.5 | MIT/Apache-2.0 | https://github.com/nical/android_system_properties |
| anes | 0.1.6 | MIT OR Apache-2.0 | https://github.com/zrzka/anes-rs |
| anstyle | 1.0.14 | MIT OR Apache-2.0 | https://github.com/rust-cli/anstyle.git |
| anyhow | 1.0.102 | MIT OR Apache-2.0 | https://github.com/dtolnay/anyhow |
| approx | 0.5.1 | Apache-2.0 | https://github.com/brendanzab/approx |
| ar_archive_writer | 0.5.1 | Apache-2.0 WITH LLVM-exception | https://github.com/rust-lang/ar_archive_writer |
| arbitrary | 1.4.2 | MIT OR Apache-2.0 | https://github.com/rust-fuzz/arbitrary/ |
| arrayref | 0.3.9 | BSD-2-Clause | https://github.com/droundy/arrayref |
| arrayvec | 0.7.6 | MIT OR Apache-2.0 | https://github.com/bluss/arrayvec |
| assert-json-diff | 2.0.2 | MIT | https://github.com/davidpdrsn/assert-json-diff.git |
| atomic-waker | 1.1.2 | Apache-2.0 OR MIT | https://github.com/smol-rs/atomic-waker |
| autocfg | 1.5.1 | Apache-2.0 OR MIT | https://github.com/cuviper/autocfg |
| az | 1.3.0 | MIT/Apache-2.0 | https://gitlab.com/tspiteri/az |
| base64 | 0.13.1 | MIT/Apache-2.0 | https://github.com/marshallpierce/rust-base64 |
| base64 | 0.21.7 | MIT OR Apache-2.0 | https://github.com/marshallpierce/rust-base64 |
| base64 | 0.22.1 | MIT OR Apache-2.0 | https://github.com/marshallpierce/rust-base64 |
| base64ct | 1.8.3 | Apache-2.0 OR MIT | https://github.com/RustCrypto/formats |
| biblatex | 0.10.0 | MIT OR Apache-2.0 | https://github.com/typst/biblatex |
| bincode | 1.3.3 | MIT | https://github.com/servo/bincode |
| bit-set | 0.5.3 | MIT/Apache-2.0 | https://github.com/contain-rs/bit-set |
| bit-set | 0.8.0 | Apache-2.0 OR MIT | https://github.com/contain-rs/bit-set |
| bit-vec | 0.6.3 | MIT/Apache-2.0 | https://github.com/contain-rs/bit-vec |
| bit-vec | 0.8.0 | Apache-2.0 OR MIT | https://github.com/contain-rs/bit-vec |
| bitflags | 1.3.2 | MIT/Apache-2.0 | https://github.com/bitflags/bitflags |
| bitflags | 2.11.1 | MIT OR Apache-2.0 | https://github.com/bitflags/bitflags |
| blake3 | 1.8.5 | CC0-1.0 OR Apache-2.0 OR Apache-2.0 WITH LLVM-exception | https://github.com/BLAKE3-team/BLAKE3 |
| block-buffer | 0.10.4 | MIT OR Apache-2.0 | https://github.com/RustCrypto/utils |
| bstr | 1.12.1 | MIT OR Apache-2.0 | https://github.com/BurntSushi/bstr |
| bumpalo | 3.20.3 | MIT OR Apache-2.0 | https://github.com/fitzgen/bumpalo |
| by_address | 1.2.1 | MIT OR Apache-2.0 | https://github.com/mbrubeck/by_address |
| bytecount | 0.6.9 | Apache-2.0/MIT | https://github.com/llogiq/bytecount |
| bytemuck | 1.25.0 | Zlib OR Apache-2.0 OR MIT | https://github.com/Lokathor/bytemuck |
| bytemuck_derive | 1.10.2 | Zlib OR Apache-2.0 OR MIT | https://github.com/Lokathor/bytemuck |
| byteorder | 1.5.0 | Unlicense OR MIT | https://github.com/BurntSushi/byteorder |
| byteorder-lite | 0.1.0 | Unlicense OR MIT | https://github.com/image-rs/byteorder-lite |
| bytes | 1.11.1 | MIT | https://github.com/tokio-rs/bytes |
| calamine | 0.26.1 | MIT | https://github.com/tafia/calamine |
| cast | 0.3.0 | MIT OR Apache-2.0 | https://github.com/japaric/cast.rs |
| cc | 1.2.62 | MIT OR Apache-2.0 | https://github.com/rust-lang/cc-rs |
| cfg_aliases | 0.2.1 | MIT | https://github.com/katharostech/cfg_aliases |
| cfg-if | 1.0.4 | MIT OR Apache-2.0 | https://github.com/rust-lang/cfg-if |
| chinese-number | 0.7.8 | MIT | https://github.com/magiclen/chinese-number |
| chinese-variant | 1.1.5 | MIT | https://github.com/magiclen/chinese-variant |
| chrono | 0.4.44 | MIT OR Apache-2.0 | https://github.com/chronotope/chrono |
| ciborium | 0.2.2 | Apache-2.0 | https://github.com/enarx/ciborium |
| ciborium-io | 0.2.2 | Apache-2.0 | https://github.com/enarx/ciborium |
| ciborium-ll | 0.2.2 | Apache-2.0 | https://github.com/enarx/ciborium |
| cipher | 0.4.4 | MIT OR Apache-2.0 | https://github.com/RustCrypto/traits |
| citationberg | 0.5.0 | MIT OR Apache-2.0 | https://github.com/typst/citationberg |
| clap | 4.6.1 | MIT OR Apache-2.0 | https://github.com/clap-rs/clap |
| clap_builder | 4.6.0 | MIT OR Apache-2.0 | https://github.com/clap-rs/clap |
| clap_lex | 1.1.0 | MIT OR Apache-2.0 | https://github.com/clap-rs/clap |
| cobs | 0.3.0 | MIT OR Apache-2.0 | https://github.com/jamesmunns/cobs.rs |
| codepage | 0.1.2 | Apache-2.0 OR MIT | https://github.com/hsivonen/codepage |
| color_quant | 1.1.0 | MIT | https://github.com/image-rs/color_quant.git |
| comemo | 0.4.0 | MIT OR Apache-2.0 | https://github.com/typst/comemo |
| comemo-macros | 0.4.0 | MIT OR Apache-2.0 | https://github.com/typst/comemo |
| constant_time_eq | 0.4.2 | CC0-1.0 OR MIT-0 OR Apache-2.0 | https://github.com/cesarb/constant_time_eq |
| convert_case | 0.6.0 | MIT | https://github.com/rutrum/convert-case |
| core_maths | 0.1.1 | MIT | https://github.com/robertbastian/core_maths |
| core-foundation | 0.10.1 | MIT OR Apache-2.0 | https://github.com/servo/core-foundation-rs |
| core-foundation-sys | 0.8.7 | MIT OR Apache-2.0 | https://github.com/servo/core-foundation-rs |
| cpufeatures | 0.2.17 | MIT OR Apache-2.0 | https://github.com/RustCrypto/utils |
| cpufeatures | 0.3.0 | MIT OR Apache-2.0 | https://github.com/RustCrypto/utils |
| crc32fast | 1.5.0 | MIT OR Apache-2.0 | https://github.com/srijs/rust-crc32fast |
| criterion | 0.5.1 | Apache-2.0 OR MIT | https://github.com/bheisler/criterion.rs |
| criterion-plot | 0.5.0 | MIT/Apache-2.0 | https://github.com/bheisler/criterion.rs |
| crossbeam-channel | 0.5.15 | MIT OR Apache-2.0 | https://github.com/crossbeam-rs/crossbeam |
| crossbeam-deque | 0.8.6 | MIT OR Apache-2.0 | https://github.com/crossbeam-rs/crossbeam |
| crossbeam-epoch | 0.9.18 | MIT OR Apache-2.0 | https://github.com/crossbeam-rs/crossbeam |
| crossbeam-utils | 0.8.21 | MIT OR Apache-2.0 | https://github.com/crossbeam-rs/crossbeam |
| crunchy | 0.2.4 | MIT | https://github.com/eira-fransham/crunchy |
| crypto-common | 0.1.7 | MIT OR Apache-2.0 | https://github.com/RustCrypto/traits |
| csv | 1.4.0 | Unlicense/MIT | https://github.com/BurntSushi/rust-csv |
| csv-core | 0.1.13 | Unlicense/MIT | https://github.com/BurntSushi/rust-csv |
| ctor | 0.2.9 | Apache-2.0 OR MIT | https://github.com/mmastrac/rust-ctor |
| ctr | 0.9.2 | MIT OR Apache-2.0 | https://github.com/RustCrypto/block-modes |
| darling | 0.20.11 | MIT | https://github.com/TedDriggs/darling |
| darling_core | 0.20.11 | MIT | https://github.com/TedDriggs/darling |
| darling_macro | 0.20.11 | MIT | https://github.com/TedDriggs/darling |
| data-url | 0.3.2 | MIT OR Apache-2.0 | https://github.com/servo/rust-url |
| deadpool | 0.12.3 | MIT OR Apache-2.0 | https://github.com/bikeshedder/deadpool |
| deadpool-runtime | 0.1.4 | MIT OR Apache-2.0 | https://github.com/bikeshedder/deadpool |
| der | 0.8.0 | Apache-2.0 OR MIT | https://github.com/RustCrypto/formats |
| deranged | 0.5.8 | MIT OR Apache-2.0 | https://github.com/jhpratt/deranged |
| derive_arbitrary | 1.4.2 | MIT OR Apache-2.0 | https://github.com/rust-fuzz/arbitrary |
| derive_builder | 0.20.2 | MIT OR Apache-2.0 | https://github.com/colin-kiegel/rust-derive-builder |
| derive_builder_core | 0.20.2 | MIT OR Apache-2.0 | https://github.com/colin-kiegel/rust-derive-builder |
| derive_builder_macro | 0.20.2 | MIT OR Apache-2.0 | https://github.com/colin-kiegel/rust-derive-builder |
| digest | 0.10.7 | MIT OR Apache-2.0 | https://github.com/RustCrypto/traits |
| displaydoc | 0.2.5 | MIT OR Apache-2.0 | https://github.com/yaahc/displaydoc |
| docx-rs | 0.4.20 | MIT | https://github.com/bokuweb/docx-rs |
| downcast-rs | 1.2.1 | MIT/Apache-2.0 | https://github.com/marcianx/downcast-rs |
| ecow | 0.2.6 | MIT OR Apache-2.0 | https://github.com/typst/ecow |
| either | 1.16.0 | MIT OR Apache-2.0 | https://github.com/rayon-rs/either |
| embedded-io | 0.4.0 | MIT OR Apache-2.0 | https://github.com/embassy-rs/embedded-io |
| embedded-io | 0.6.1 | MIT OR Apache-2.0 | https://github.com/rust-embedded/embedded-hal |
| encoding_rs | 0.8.35 | (Apache-2.0 OR MIT) AND BSD-3-Clause | https://github.com/hsivonen/encoding_rs |
| enum-ordinalize | 4.3.2 | MIT | https://github.com/magiclen/enum-ordinalize |
| enum-ordinalize-derive | 4.3.2 | MIT | https://github.com/magiclen/enum-ordinalize |
| equivalent | 1.0.2 | Apache-2.0 OR MIT | https://github.com/indexmap-rs/equivalent |
| errno | 0.3.14 | MIT OR Apache-2.0 | https://github.com/lambda-fairy/rust-errno |
| esaxx-rs | 0.1.10 | Apache-2.0 | https://github.com/Narsil/esaxx-rs |
| euclid | 0.22.14 | MIT OR Apache-2.0 | https://github.com/servo/euclid |
| fallible-iterator | 0.3.0 | MIT/Apache-2.0 | https://github.com/sfackler/rust-fallible-iterator |
| fallible-streaming-iterator | 0.1.9 | MIT/Apache-2.0 | https://github.com/sfackler/fallible-streaming-iterator |
| fancy-regex | 0.11.0 | MIT | https://github.com/fancy-regex/fancy-regex |
| fancy-regex | 0.13.0 | MIT | https://github.com/fancy-regex/fancy-regex |
| fancy-regex | 0.16.2 | MIT | https://github.com/fancy-regex/fancy-regex |
| fast-srgb8 | 1.0.0 | MIT OR Apache-2.0 OR CC0-1.0 | https://github.com/thomcc/fast-srgb8 |
| fastrand | 2.4.1 | Apache-2.0 OR MIT | https://github.com/smol-rs/fastrand |
| fax | 0.2.7 | MIT | https://github.com/pdf-rs/fax |
| fdeflate | 0.3.7 | MIT OR Apache-2.0 | https://github.com/image-rs/fdeflate |
| filetime | 0.2.29 | MIT/Apache-2.0 | https://github.com/alexcrichton/filetime |
| find-msvc-tools | 0.1.9 | MIT OR Apache-2.0 | https://github.com/rust-lang/cc-rs |
| flate2 | 1.1.9 | MIT OR Apache-2.0 | https://github.com/rust-lang/flate2-rs |
| float-cmp | 0.9.0 | MIT | https://github.com/mikedilger/float-cmp |
| fnv | 1.0.7 | Apache-2.0 / MIT | https://github.com/servo/rust-fnv |
| foldhash | 0.1.5 | Zlib | https://github.com/orlp/foldhash |
| font-types | 0.10.1 | MIT OR Apache-2.0 | https://github.com/googlefonts/fontations |
| fontconfig-parser | 0.5.8 | MIT | https://github.com/Riey/fontconfig-parser |
| fontdb | 0.21.0 | MIT | https://github.com/RazrFalcon/fontdb |
| foreign-types | 0.3.2 | MIT/Apache-2.0 | https://github.com/sfackler/foreign-types |
| foreign-types-shared | 0.1.1 | MIT/Apache-2.0 | https://github.com/sfackler/foreign-types |
| form_urlencoded | 1.2.2 | MIT OR Apache-2.0 | https://github.com/servo/rust-url |
| fraction | 0.13.1 | MIT/Apache-2.0 | https://github.com/dnsl48/fraction.git |
| fsevent-sys | 4.1.0 | MIT | https://github.com/octplane/fsevent-rust/tree/master/fsevent-sys |
| futures | 0.3.32 | MIT OR Apache-2.0 | https://github.com/rust-lang/futures-rs |
| futures-channel | 0.3.32 | MIT OR Apache-2.0 | https://github.com/rust-lang/futures-rs |
| futures-core | 0.3.32 | MIT OR Apache-2.0 | https://github.com/rust-lang/futures-rs |
| futures-executor | 0.3.32 | MIT OR Apache-2.0 | https://github.com/rust-lang/futures-rs |
| futures-io | 0.3.32 | MIT OR Apache-2.0 | https://github.com/rust-lang/futures-rs |
| futures-macro | 0.3.32 | MIT OR Apache-2.0 | https://github.com/rust-lang/futures-rs |
| futures-sink | 0.3.32 | MIT OR Apache-2.0 | https://github.com/rust-lang/futures-rs |
| futures-task | 0.3.32 | MIT OR Apache-2.0 | https://github.com/rust-lang/futures-rs |
| futures-util | 0.3.32 | MIT OR Apache-2.0 | https://github.com/rust-lang/futures-rs |
| generic-array | 0.14.7 | MIT | https://github.com/fizyk20/generic-array.git |
| getopts | 0.2.24 | MIT OR Apache-2.0 | https://github.com/rust-lang/getopts |
| getrandom | 0.2.17 | MIT OR Apache-2.0 | https://github.com/rust-random/getrandom |
| getrandom | 0.3.4 | MIT OR Apache-2.0 | https://github.com/rust-random/getrandom |
| getrandom | 0.4.2 | MIT OR Apache-2.0 | https://github.com/rust-random/getrandom |
| ghash | 0.5.1 | Apache-2.0 OR MIT | https://github.com/RustCrypto/universal-hashes |
| gif | 0.13.3 | MIT OR Apache-2.0 | https://github.com/image-rs/image-gif |
| gif | 0.14.2 | MIT OR Apache-2.0 | https://github.com/image-rs/image-gif |
| globset | 0.4.18 | Unlicense OR MIT | https://github.com/BurntSushi/ripgrep/tree/master/crates/globset |
| h2 | 0.4.14 | MIT | https://github.com/hyperium/h2 |
| half | 2.7.1 | MIT OR Apache-2.0 | https://github.com/VoidStarKat/half-rs |
| hashbrown | 0.14.5 | MIT OR Apache-2.0 | https://github.com/rust-lang/hashbrown |
| hashbrown | 0.15.5 | MIT OR Apache-2.0 | https://github.com/rust-lang/hashbrown |
| hashbrown | 0.17.1 | MIT OR Apache-2.0 | https://github.com/rust-lang/hashbrown |
| hashlink | 0.9.1 | MIT OR Apache-2.0 | https://github.com/kyren/hashlink |
| hayagriva | 0.8.1 | MIT OR Apache-2.0 | https://github.com/typst/hayagriva |
| heck | 0.5.0 | MIT OR Apache-2.0 | https://github.com/withoutboats/heck |
| hermit-abi | 0.5.2 | MIT OR Apache-2.0 | https://github.com/hermit-os/hermit-rs |
| hkdf | 0.12.4 | MIT OR Apache-2.0 | https://github.com/RustCrypto/KDFs/ |
| hmac | 0.12.1 | MIT OR Apache-2.0 | https://github.com/RustCrypto/MACs |
| http | 1.4.0 | MIT OR Apache-2.0 | https://github.com/hyperium/http |
| http-body | 1.0.1 | MIT | https://github.com/hyperium/http-body |
| http-body-util | 0.1.3 | MIT | https://github.com/hyperium/http-body |
| httparse | 1.10.1 | MIT OR Apache-2.0 | https://github.com/seanmonstar/httparse |
| httpdate | 1.0.3 | MIT OR Apache-2.0 | https://github.com/pyfisch/httpdate |
| hyper | 1.9.0 | MIT | https://github.com/hyperium/hyper |
| hyper-rustls | 0.27.9 | Apache-2.0 OR ISC OR MIT | https://github.com/rustls/hyper-rustls |
| hyper-util | 0.1.20 | MIT | https://github.com/hyperium/hyper-util |
| hypher | 0.1.7 | MIT OR Apache-2.0 | https://github.com/typst/hypher |
| iana-time-zone | 0.1.65 | MIT OR Apache-2.0 | https://github.com/strawlab/iana-time-zone |
| iana-time-zone-haiku | 0.1.2 | MIT OR Apache-2.0 | https://github.com/strawlab/iana-time-zone |
| icu_collections | 1.5.0 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| icu_collections | 2.2.0 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| icu_locale_core | 2.2.0 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| icu_locid | 1.5.0 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| icu_locid_transform | 1.5.0 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| icu_locid_transform_data | 1.5.1 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| icu_normalizer | 2.2.0 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| icu_normalizer_data | 2.2.0 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| icu_properties | 1.5.1 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| icu_properties | 2.2.0 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| icu_properties_data | 1.5.1 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| icu_properties_data | 2.2.0 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| icu_provider | 1.5.0 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| icu_provider | 2.2.0 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| icu_provider_adapters | 1.5.0 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| icu_provider_blob | 1.5.0 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| icu_provider_macros | 1.5.0 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| icu_segmenter | 1.5.0 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| icu_segmenter_data | 1.5.1 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| id-arena | 2.3.0 | MIT/Apache-2.0 | https://github.com/fitzgen/id-arena |
| ident_case | 1.0.1 | MIT/Apache-2.0 | https://github.com/TedDriggs/ident_case |
| idna | 1.1.0 | MIT OR Apache-2.0 | https://github.com/servo/rust-url/ |
| idna_adapter | 1.2.2 | Apache-2.0 OR MIT | https://github.com/hsivonen/idna_adapter |
| if_chain | 1.0.3 | MIT/Apache-2.0 | https://github.com/lambda-fairy/if_chain |
| ignore | 0.4.25 | Unlicense OR MIT | https://github.com/BurntSushi/ripgrep/tree/master/crates/ignore |
| image | 0.25.10 | MIT OR Apache-2.0 | https://github.com/image-rs/image |
| image-webp | 0.1.3 | MIT OR Apache-2.0 | https://github.com/image-rs/image-webp |
| image-webp | 0.2.4 | MIT OR Apache-2.0 | https://github.com/image-rs/image-webp |
| imagesize | 0.13.0 | MIT | https://github.com/Roughsketch/imagesize |
| indexmap | 2.14.0 | Apache-2.0 OR MIT | https://github.com/indexmap-rs/indexmap |
| indexmap-nostd | 0.4.0 | Apache-2.0 | https://github.com/robbepop/indexmap-nostd |
| inotify | 0.9.6 | ISC | https://github.com/hannobraun/inotify |
| inotify-sys | 0.1.5 | ISC | https://github.com/hannobraun/inotify-sys |
| inout | 0.1.4 | MIT OR Apache-2.0 | https://github.com/RustCrypto/utils |
| ipnet | 2.12.0 | MIT OR Apache-2.0 | https://github.com/krisprice/ipnet |
| is-terminal | 0.4.17 | MIT | https://github.com/sunfishcode/is-terminal |
| iso8601 | 0.6.3 | MIT | https://github.com/badboy/iso8601 |
| itertools | 0.10.5 | MIT/Apache-2.0 | https://github.com/rust-itertools/itertools |
| itertools | 0.11.0 | MIT OR Apache-2.0 | https://github.com/rust-itertools/itertools |
| itertools | 0.12.1 | MIT OR Apache-2.0 | https://github.com/rust-itertools/itertools |
| itoa | 1.0.18 | MIT OR Apache-2.0 | https://github.com/dtolnay/itoa |
| js-sys | 0.3.99 | MIT OR Apache-2.0 | https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/js-sys |
| jsonschema | 0.17.1 | MIT | https://github.com/Stranger6667/jsonschema-rs |
| kamadak-exif | 0.5.5 | BSD-2-Clause | https://github.com/kamadak/exif-rs |
| kamadak-exif | 0.6.1 | BSD-2-Clause | https://github.com/kamadak/exif-rs |
| kqueue | 1.1.1 | MIT | https://gitlab.com/rust-kqueue/rust-kqueue |
| kqueue-sys | 1.1.2 | MIT | https://gitlab.com/rust-kqueue/rust-kqueue-sys |
| kurbo | 0.11.3 | Apache-2.0 OR MIT | https://github.com/linebender/kurbo |
| kurbo | 0.12.0 | Apache-2.0 OR MIT | https://github.com/linebender/kurbo |
| lazy_static | 1.5.0 | MIT OR Apache-2.0 | https://github.com/rust-lang-nursery/lazy-static.rs |
| leb128fmt | 0.1.0 | MIT OR Apache-2.0 | https://github.com/bluk/leb128fmt |
| libc | 0.2.186 | MIT OR Apache-2.0 | https://github.com/rust-lang/libc |
| libloading | 0.8.9 | ISC | https://github.com/nagisa/rust_libloading/ |
| libm | 0.2.16 | MIT | https://github.com/rust-lang/compiler-builtins |
| libsqlite3-sys | 0.30.1 | MIT | https://github.com/rusqlite/rusqlite |
| linked-hash-map | 0.5.6 | MIT/Apache-2.0 | https://github.com/contain-rs/linked-hash-map |
| linux-raw-sys | 0.12.1 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | https://github.com/sunfishcode/linux-raw-sys |
| lipsum | 0.9.1 | MIT | https://github.com/mgeisler/lipsum/ |
| litemap | 0.7.5 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| litemap | 0.8.2 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| lock_api | 0.4.14 | MIT OR Apache-2.0 | https://github.com/Amanieu/parking_lot |
| log | 0.4.29 | MIT OR Apache-2.0 | https://github.com/rust-lang/log |
| lopdf | 0.34.0 | MIT | https://github.com/J-F-Liu/lopdf.git |
| lru-slab | 0.1.2 | MIT OR Apache-2.0 OR Zlib | https://github.com/Ralith/lru-slab |
| macro_rules_attribute | 0.2.2 | Apache-2.0 OR MIT OR Zlib | https://github.com/danielhenrymantilla/macro_rules_attribute-rs |
| macro_rules_attribute-proc_macro | 0.2.2 | Apache-2.0 OR MIT OR Zlib | https://github.com/danielhenrymantilla/macro_rules_attribute-rs |
| matrixmultiply | 0.3.10 | MIT/Apache-2.0 | https://github.com/bluss/matrixmultiply/ |
| md-5 | 0.10.6 | MIT OR Apache-2.0 | https://github.com/RustCrypto/hashes |
| memchr | 2.8.0 | Unlicense OR MIT | https://github.com/BurntSushi/memchr |
| memmap2 | 0.9.10 | MIT OR Apache-2.0 | https://github.com/RazrFalcon/memmap2-rs |
| minimal-lexical | 0.2.1 | MIT/Apache-2.0 | https://github.com/Alexhuszagh/minimal-lexical |
| miniz_oxide | 0.8.9 | MIT OR Zlib OR Apache-2.0 | https://github.com/Frommi/miniz_oxide/tree/master/miniz_oxide |
| mio | 0.8.11 | MIT | https://github.com/tokio-rs/mio |
| mio | 1.2.0 | MIT | https://github.com/tokio-rs/mio |
| monostate | 0.1.18 | MIT OR Apache-2.0 | https://github.com/dtolnay/monostate |
| monostate-impl | 0.1.18 | MIT OR Apache-2.0 | https://github.com/dtolnay/monostate |
| moxcms | 0.8.1 | BSD-3-Clause OR Apache-2.0 | https://github.com/awxkee/moxcms.git |
| multi-stash | 0.2.0 | MIT/Apache-2.0 | https://github.com/robbepop/multi-stash |
| mutate_once | 0.1.2 | BSD-2-Clause | https://github.com/kamadak/mutate_once-rs |
| napi | 2.16.17 | MIT | https://github.com/napi-rs/napi-rs |
| napi-build | 2.3.2 | MIT | https://github.com/napi-rs/napi-rs |
| napi-derive | 2.16.13 | MIT | https://github.com/napi-rs/napi-rs |
| napi-derive-backend | 1.0.75 | MIT | https://github.com/napi-rs/napi-rs |
| napi-sys | 2.4.0 | MIT | https://github.com/napi-rs/napi-rs |
| native-tls | 0.2.18 | MIT OR Apache-2.0 | https://github.com/rust-native-tls/rust-native-tls |
| ndarray | 0.16.1 | MIT OR Apache-2.0 | https://github.com/rust-ndarray/ndarray |
| nom | 7.1.3 | MIT | https://github.com/Geal/nom |
| nom | 8.0.0 | MIT | https://github.com/rust-bakery/nom |
| notify | 6.1.1 | CC0-1.0 | https://github.com/notify-rs/notify.git |
| num | 0.4.3 | MIT OR Apache-2.0 | https://github.com/rust-num/num |
| num_cpus | 1.17.0 | MIT OR Apache-2.0 | https://github.com/seanmonstar/num_cpus |
| num-bigint | 0.4.6 | MIT OR Apache-2.0 | https://github.com/rust-num/num-bigint |
| num-cmp | 0.1.0 | MIT/Apache-2.0 | https://github.com/lifthrasiir/num-cmp |
| num-complex | 0.4.6 | MIT OR Apache-2.0 | https://github.com/rust-num/num-complex |
| num-conv | 0.2.2 | MIT OR Apache-2.0 | https://github.com/jhpratt/num-conv |
| num-derive | 0.4.2 | MIT OR Apache-2.0 | https://github.com/rust-num/num-derive |
| num-integer | 0.1.46 | MIT OR Apache-2.0 | https://github.com/rust-num/num-integer |
| num-iter | 0.1.45 | MIT OR Apache-2.0 | https://github.com/rust-num/num-iter |
| num-rational | 0.4.2 | MIT OR Apache-2.0 | https://github.com/rust-num/num-rational |
| num-traits | 0.2.19 | MIT OR Apache-2.0 | https://github.com/rust-num/num-traits |
| numerals | 0.1.4 | MIT |  |
| object | 0.37.3 | Apache-2.0 OR MIT | https://github.com/gimli-rs/object |
| once_cell | 1.21.4 | MIT OR Apache-2.0 | https://github.com/matklad/once_cell |
| oorandom | 11.1.5 | MIT | https://hg.sr.ht/~icefox/oorandom |
| opaque-debug | 0.3.1 | MIT OR Apache-2.0 | https://github.com/RustCrypto/utils |
| openssl | 0.10.80 | Apache-2.0 | https://github.com/rust-openssl/rust-openssl |
| openssl-macros | 0.1.1 | MIT/Apache-2.0 |  |
| openssl-probe | 0.2.1 | MIT OR Apache-2.0 | https://github.com/rustls/openssl-probe |
| openssl-src | 300.6.0+3.6.2 | MIT/Apache-2.0 | https://github.com/alexcrichton/openssl-src-rs |
| openssl-sys | 0.9.116 | MIT | https://github.com/rust-openssl/rust-openssl |
| ort | 2.0.0-rc.10 | MIT OR Apache-2.0 | https://github.com/pykeio/ort |
| ort-sys | 2.0.0-rc.10 | MIT OR Apache-2.0 | https://github.com/pykeio/ort |
| palette | 0.7.6 | MIT OR Apache-2.0 | https://github.com/Ogeon/palette |
| palette_derive | 0.7.6 | MIT OR Apache-2.0 | https://github.com/Ogeon/palette |
| parking_lot | 0.12.5 | MIT OR Apache-2.0 | https://github.com/Amanieu/parking_lot |
| parking_lot_core | 0.9.12 | MIT OR Apache-2.0 | https://github.com/Amanieu/parking_lot |
| paste | 1.0.15 | MIT OR Apache-2.0 | https://github.com/dtolnay/paste |
| pdf-writer | 0.12.1 | MIT OR Apache-2.0 | https://github.com/typst/pdf-writer |
| pem-rfc7468 | 1.0.0 | Apache-2.0 OR MIT | https://github.com/RustCrypto/formats |
| percent-encoding | 2.3.2 | MIT OR Apache-2.0 | https://github.com/servo/rust-url/ |
| phf | 0.11.3 | MIT | https://github.com/rust-phf/rust-phf |
| phf_generator | 0.11.3 | MIT | https://github.com/rust-phf/rust-phf |
| phf_macros | 0.11.3 | MIT | https://github.com/rust-phf/rust-phf |
| phf_shared | 0.11.3 | MIT | https://github.com/rust-phf/rust-phf |
| pico-args | 0.5.0 | MIT | https://github.com/RazrFalcon/pico-args |
| pin-project-lite | 0.2.17 | Apache-2.0 OR MIT | https://github.com/taiki-e/pin-project-lite |
| pkg-config | 0.3.33 | MIT OR Apache-2.0 | https://github.com/rust-lang/pkg-config-rs |
| plist | 1.9.0 | MIT | https://github.com/ebarnard/rust-plist/ |
| png | 0.17.16 | MIT OR Apache-2.0 | https://github.com/image-rs/image-png |
| png | 0.18.1 | MIT OR Apache-2.0 | https://github.com/image-rs/image-png |
| polyval | 0.6.2 | Apache-2.0 OR MIT | https://github.com/RustCrypto/universal-hashes |
| portable-atomic | 1.13.1 | Apache-2.0 OR MIT | https://github.com/taiki-e/portable-atomic |
| portable-atomic-util | 0.2.7 | Apache-2.0 OR MIT | https://github.com/taiki-e/portable-atomic-util |
| postcard | 1.1.3 | MIT OR Apache-2.0 | https://github.com/jamesmunns/postcard |
| potential_utf | 0.1.5 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| powerfmt | 0.2.0 | MIT OR Apache-2.0 | https://github.com/jhpratt/powerfmt |
| ppv-lite86 | 0.2.21 | MIT OR Apache-2.0 | https://github.com/cryptocorrosion/cryptocorrosion |
| prettyplease | 0.2.37 | MIT OR Apache-2.0 | https://github.com/dtolnay/prettyplease |
| proc-macro2 | 1.0.106 | MIT OR Apache-2.0 | https://github.com/dtolnay/proc-macro2 |
| psm | 0.1.31 | MIT OR Apache-2.0 | https://github.com/rust-lang/stacker/ |
| pulldown-cmark | 0.12.2 | MIT | https://github.com/raphlinus/pulldown-cmark |
| pulldown-cmark-escape | 0.11.0 | MIT | https://github.com/raphlinus/pulldown-cmark |
| pxfm | 0.1.29 | BSD-3-Clause OR Apache-2.0 | https://github.com/awxkee/pxfm |
| qcms | 0.3.0 | MIT | https://github.com/FirefoxGraphics/qcms |
| quick-error | 2.0.1 | MIT/Apache-2.0 | http://github.com/tailhook/quick-error |
| quick-xml | 0.31.0 | MIT | https://github.com/tafia/quick-xml |
| quick-xml | 0.36.2 | MIT | https://github.com/tafia/quick-xml |
| quick-xml | 0.39.4 | MIT | https://github.com/tafia/quick-xml |
| quinn | 0.11.9 | MIT OR Apache-2.0 | https://github.com/quinn-rs/quinn |
| quinn-proto | 0.11.14 | MIT OR Apache-2.0 | https://github.com/quinn-rs/quinn |
| quinn-udp | 0.5.14 | MIT OR Apache-2.0 | https://github.com/quinn-rs/quinn |
| quote | 1.0.45 | MIT OR Apache-2.0 | https://github.com/dtolnay/quote |
| r-efi | 5.3.0 | MIT OR Apache-2.0 OR LGPL-2.1-or-later | https://github.com/r-efi/r-efi |
| r-efi | 6.0.0 | MIT OR Apache-2.0 OR LGPL-2.1-or-later | https://github.com/r-efi/r-efi |
| rand | 0.8.6 | MIT OR Apache-2.0 | https://github.com/rust-random/rand |
| rand | 0.9.4 | MIT OR Apache-2.0 | https://github.com/rust-random/rand |
| rand_chacha | 0.3.1 | MIT OR Apache-2.0 | https://github.com/rust-random/rand |
| rand_chacha | 0.9.0 | MIT OR Apache-2.0 | https://github.com/rust-random/rand |
| rand_core | 0.6.4 | MIT OR Apache-2.0 | https://github.com/rust-random/rand |
| rand_core | 0.9.5 | MIT OR Apache-2.0 | https://github.com/rust-random/rand |
| rangemap | 1.7.1 | MIT/Apache-2.0 | https://github.com/jeffparsons/rangemap |
| rawpointer | 0.2.1 | MIT/Apache-2.0 | https://github.com/bluss/rawpointer/ |
| rayon | 1.12.0 | MIT OR Apache-2.0 | https://github.com/rayon-rs/rayon |
| rayon-cond | 0.3.0 | Apache-2.0/MIT | https://github.com/cuviper/rayon-cond |
| rayon-core | 1.13.0 | MIT OR Apache-2.0 | https://github.com/rayon-rs/rayon |
| read-fonts | 0.35.0 | MIT OR Apache-2.0 | https://github.com/googlefonts/fontations |
| redox_syscall | 0.5.18 | MIT | https://gitlab.redox-os.org/redox-os/syscall |
| regex | 1.12.3 | MIT OR Apache-2.0 | https://github.com/rust-lang/regex |
| regex-automata | 0.4.14 | MIT OR Apache-2.0 | https://github.com/rust-lang/regex |
| regex-syntax | 0.8.10 | MIT OR Apache-2.0 | https://github.com/rust-lang/regex |
| reqwest | 0.12.28 | MIT OR Apache-2.0 | https://github.com/seanmonstar/reqwest |
| resvg | 0.43.0 | MPL-2.0 | https://github.com/RazrFalcon/resvg |
| rgb | 0.8.53 | MIT | https://github.com/kornelski/rust-rgb |
| ring | 0.17.14 | Apache-2.0 AND ISC | https://github.com/briansmith/ring |
| roxmltree | 0.20.0 | MIT OR Apache-2.0 | https://github.com/RazrFalcon/roxmltree |
| rusqlite | 0.32.1 | MIT | https://github.com/rusqlite/rusqlite |
| rust_decimal | 1.42.0 | MIT | https://github.com/paupino/rust-decimal |
| rust_xlsxwriter | 0.95.0 | MIT OR Apache-2.0 | https://github.com/jmcnamara/rust_xlsxwriter |
| rustc-hash | 2.1.2 | Apache-2.0 OR MIT | https://github.com/rust-lang/rustc-hash |
| rustix | 1.1.4 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | https://github.com/bytecodealliance/rustix |
| rustls | 0.23.40 | Apache-2.0 OR ISC OR MIT | https://github.com/rustls/rustls |
| rustls-pki-types | 1.14.1 | MIT OR Apache-2.0 | https://github.com/rustls/pki-types |
| rustls-webpki | 0.103.13 | ISC | https://github.com/rustls/webpki |
| rustversion | 1.0.22 | MIT OR Apache-2.0 | https://github.com/dtolnay/rustversion |
| rustybuzz | 0.18.0 | MIT | https://github.com/RazrFalcon/rustybuzz |
| ryu | 1.0.23 | Apache-2.0 OR BSL-1.0 | https://github.com/dtolnay/ryu |
| same-file | 1.0.6 | Unlicense/MIT | https://github.com/BurntSushi/same-file |
| schannel | 0.1.29 | MIT | https://github.com/steffengy/schannel-rs |
| scopeguard | 1.2.0 | MIT OR Apache-2.0 | https://github.com/bluss/scopeguard |
| security-framework | 3.7.0 | MIT OR Apache-2.0 | https://github.com/kornelski/rust-security-framework |
| security-framework-sys | 2.17.0 | MIT OR Apache-2.0 | https://github.com/kornelski/rust-security-framework |
| semver | 1.0.28 | MIT OR Apache-2.0 | https://github.com/dtolnay/semver |
| serde | 1.0.228 | MIT OR Apache-2.0 | https://github.com/serde-rs/serde |
| serde_core | 1.0.228 | MIT OR Apache-2.0 | https://github.com/serde-rs/serde |
| serde_derive | 1.0.228 | MIT OR Apache-2.0 | https://github.com/serde-rs/serde |
| serde_json | 1.0.150 | MIT OR Apache-2.0 | https://github.com/serde-rs/json |
| serde_spanned | 0.6.9 | MIT OR Apache-2.0 | https://github.com/toml-rs/toml |
| serde_urlencoded | 0.7.1 | MIT/Apache-2.0 | https://github.com/nox/serde_urlencoded |
| serde_yaml | 0.9.34+deprecated | MIT OR Apache-2.0 | https://github.com/dtolnay/serde-yaml |
| sha1_smol | 1.0.1 | BSD-3-Clause | https://github.com/mitsuhiko/sha1-smol |
| sha2 | 0.10.9 | MIT OR Apache-2.0 | https://github.com/RustCrypto/hashes |
| shlex | 1.3.0 | MIT OR Apache-2.0 | https://github.com/comex/rust-shlex |
| signal-hook-registry | 1.4.8 | MIT OR Apache-2.0 | https://github.com/vorner/signal-hook |
| simd-adler32 | 0.3.9 | MIT | https://github.com/mcountryman/simd-adler32 |
| simplecss | 0.2.2 | Apache-2.0 OR MIT | https://github.com/linebender/simplecss |
| siphasher | 1.0.3 | MIT/Apache-2.0 | https://github.com/jedisct1/rust-siphash |
| skrifa | 0.37.0 | MIT OR Apache-2.0 | https://github.com/googlefonts/fontations |
| slab | 0.4.12 | MIT | https://github.com/tokio-rs/slab |
| slotmap | 1.1.1 | Zlib | https://github.com/orlp/slotmap |
| smallvec | 1.15.1 | MIT OR Apache-2.0 | https://github.com/servo/rust-smallvec |
| smallvec | 2.0.0-alpha.10 | MIT OR Apache-2.0 | https://github.com/servo/rust-smallvec |
| socket2 | 0.6.3 | MIT OR Apache-2.0 | https://github.com/rust-lang/socket2 |
| socks | 0.3.4 | MIT/Apache-2.0 | https://github.com/sfackler/rust-socks |
| spin | 0.9.8 | MIT | https://github.com/mvdnes/spin-rs.git |
| spm_precompiled | 0.1.4 | Apache-2.0 | https://github.com/huggingface/spm_precompiled |
| stable_deref_trait | 1.2.1 | MIT OR Apache-2.0 | https://github.com/storyyeller/stable_deref_trait |
| stacker | 0.1.24 | MIT OR Apache-2.0 | https://github.com/rust-lang/stacker |
| strict-num | 0.1.1 | MIT | https://github.com/RazrFalcon/strict-num |
| string-interner | 0.17.0 | MIT/Apache-2.0 | https://github.com/robbepop/string-interner |
| strsim | 0.11.1 | MIT | https://github.com/rapidfuzz/strsim-rs |
| strum | 0.26.3 | MIT | https://github.com/Peternator7/strum |
| strum_macros | 0.26.4 | MIT | https://github.com/Peternator7/strum |
| subsetter | 0.2.3 | MIT OR Apache-2.0 | https://github.com/typst/subsetter |
| subtle | 2.6.1 | BSD-3-Clause | https://github.com/dalek-cryptography/subtle |
| svg2pdf | 0.12.0 | MIT OR Apache-2.0 | https://github.com/typst/svg2pdf |
| svgtypes | 0.15.3 | Apache-2.0 OR MIT | https://github.com/linebender/svgtypes |
| syn | 2.0.117 | MIT OR Apache-2.0 | https://github.com/dtolnay/syn |
| sync_wrapper | 1.0.2 | Apache-2.0 | https://github.com/Actyx/sync_wrapper |
| synstructure | 0.13.2 | MIT | https://github.com/mystor/synstructure |
| syntect | 5.3.0 | MIT | https://github.com/trishume/syntect |
| tar | 0.4.46 | MIT OR Apache-2.0 | https://github.com/composefs/tar-rs |
| tempfile | 3.27.0 | MIT OR Apache-2.0 | https://github.com/Stebalien/tempfile |
| thin-vec | 0.2.18 | MIT OR Apache-2.0 | https://github.com/mozilla/thin-vec |
| thiserror | 1.0.69 | MIT OR Apache-2.0 | https://github.com/dtolnay/thiserror |
| thiserror | 2.0.18 | MIT OR Apache-2.0 | https://github.com/dtolnay/thiserror |
| thiserror-impl | 1.0.69 | MIT OR Apache-2.0 | https://github.com/dtolnay/thiserror |
| thiserror-impl | 2.0.18 | MIT OR Apache-2.0 | https://github.com/dtolnay/thiserror |
| tiff | 0.11.3 | MIT | https://github.com/image-rs/image-tiff |
| time | 0.3.47 | MIT OR Apache-2.0 | https://github.com/time-rs/time |
| time-core | 0.1.8 | MIT OR Apache-2.0 | https://github.com/time-rs/time |
| time-macros | 0.2.27 | MIT OR Apache-2.0 | https://github.com/time-rs/time |
| tiny-skia | 0.11.4 | BSD-3-Clause | https://github.com/RazrFalcon/tiny-skia |
| tiny-skia-path | 0.11.4 | BSD-3-Clause | https://github.com/RazrFalcon/tiny-skia/tree/master/path |
| tinystr | 0.7.6 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| tinystr | 0.8.3 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| tinytemplate | 1.2.1 | Apache-2.0 OR MIT | https://github.com/bheisler/TinyTemplate |
| tinyvec | 1.11.0 | Zlib OR Apache-2.0 OR MIT | https://github.com/Lokathor/tinyvec |
| tinyvec_macros | 0.1.1 | MIT OR Apache-2.0 OR Zlib | https://github.com/Soveu/tinyvec_macros |
| tokenizers | 0.20.4 | Apache-2.0 | https://github.com/huggingface/tokenizers |
| tokio | 1.52.3 | MIT | https://github.com/tokio-rs/tokio |
| tokio-macros | 2.7.0 | MIT | https://github.com/tokio-rs/tokio |
| tokio-rustls | 0.26.4 | MIT OR Apache-2.0 | https://github.com/rustls/tokio-rustls |
| tokio-util | 0.7.18 | MIT | https://github.com/tokio-rs/tokio |
| toml | 0.8.23 | MIT OR Apache-2.0 | https://github.com/toml-rs/toml |
| toml_datetime | 0.6.11 | MIT OR Apache-2.0 | https://github.com/toml-rs/toml |
| toml_edit | 0.22.27 | MIT OR Apache-2.0 | https://github.com/toml-rs/toml |
| toml_write | 0.1.2 | MIT OR Apache-2.0 | https://github.com/toml-rs/toml |
| tower | 0.5.3 | MIT | https://github.com/tower-rs/tower |
| tower-http | 0.6.11 | MIT | https://github.com/tower-rs/tower-http |
| tower-layer | 0.3.3 | MIT | https://github.com/tower-rs/tower |
| tower-service | 0.3.3 | MIT | https://github.com/tower-rs/tower |
| tracing | 0.1.44 | MIT | https://github.com/tokio-rs/tracing |
| tracing-core | 0.1.36 | MIT | https://github.com/tokio-rs/tracing |
| try-lock | 0.2.5 | MIT | https://github.com/seanmonstar/try-lock |
| ttf-parser | 0.24.1 | MIT OR Apache-2.0 | https://github.com/RazrFalcon/ttf-parser |
| two-face | 0.4.5 | MIT OR Apache-2.0 | https://github.com/CosmicHorrorDev/two-face |
| typed-arena | 2.0.2 | MIT | https://github.com/SimonSapin/rust-typed-arena |
| typed-path | 0.12.3 | MIT OR Apache-2.0 | https://github.com/chipsenkbeil/typed-path |
| typenum | 1.20.0 | MIT OR Apache-2.0 | https://github.com/paholg/typenum |
| typst | 0.12.0 | Apache-2.0 | https://github.com/typst/typst |
| typst-assets | 0.12.0 | Apache-2.0 | https://github.com/typst/typst-assets |
| typst-macros | 0.12.0 | Apache-2.0 | https://github.com/typst/typst |
| typst-pdf | 0.12.0 | Apache-2.0 | https://github.com/typst/typst |
| typst-svg | 0.12.0 | Apache-2.0 | https://github.com/typst/typst |
| typst-syntax | 0.12.0 | Apache-2.0 | https://github.com/typst/typst |
| typst-timing | 0.12.0 | Apache-2.0 | https://github.com/typst/typst |
| typst-utils | 0.12.0 | Apache-2.0 | https://github.com/typst/typst |
| unic-langid | 0.9.6 | MIT OR Apache-2.0 | https://github.com/zbraniecki/unic-locale |
| unic-langid-impl | 0.9.6 | MIT OR Apache-2.0 | https://github.com/zbraniecki/unic-locale |
| unicase | 2.9.0 | MIT OR Apache-2.0 | https://github.com/seanmonstar/unicase |
| unicode_categories | 0.1.1 | MIT OR Apache-2.0 | https://github.com/swgillespie/unicode-categories |
| unicode-bidi | 0.3.18 | MIT OR Apache-2.0 | https://github.com/servo/unicode-bidi |
| unicode-bidi-mirroring | 0.3.0 | MIT/Apache-2.0 | https://github.com/RazrFalcon/unicode-bidi-mirroring |
| unicode-ccc | 0.3.0 | MIT/Apache-2.0 | https://github.com/RazrFalcon/unicode-ccc |
| unicode-ident | 1.0.24 | (MIT OR Apache-2.0) AND Unicode-3.0 | https://github.com/dtolnay/unicode-ident |
| unicode-math-class | 0.1.0 | MIT OR Apache-2.0 | https://github.com/typst/unicode-math-class |
| unicode-normalization | 0.1.25 | MIT OR Apache-2.0 | https://github.com/unicode-rs/unicode-normalization |
| unicode-normalization-alignments | 0.1.12 | MIT/Apache-2.0 | https://github.com/n1t0/unicode-normalization |
| unicode-properties | 0.1.4 | MIT/Apache-2.0 | https://github.com/unicode-rs/unicode-properties |
| unicode-script | 0.5.8 | MIT OR Apache-2.0 | https://github.com/unicode-rs/unicode-script |
| unicode-segmentation | 1.13.2 | MIT OR Apache-2.0 | https://github.com/unicode-rs/unicode-segmentation |
| unicode-vo | 0.1.0 | MIT/Apache-2.0 | https://github.com/RazrFalcon/unicode-vo |
| unicode-width | 0.2.2 | MIT OR Apache-2.0 | https://github.com/unicode-rs/unicode-width |
| unicode-xid | 0.2.6 | MIT OR Apache-2.0 | https://github.com/unicode-rs/unicode-xid |
| universal-hash | 0.5.1 | MIT OR Apache-2.0 | https://github.com/RustCrypto/traits |
| unsafe-libyaml | 0.2.11 | MIT | https://github.com/dtolnay/unsafe-libyaml |
| unscanny | 0.1.0 | MIT OR Apache-2.0 | https://github.com/typst/unscanny |
| untrusted | 0.9.0 | ISC | https://github.com/briansmith/untrusted |
| ureq | 3.3.0 | MIT OR Apache-2.0 | https://github.com/algesten/ureq |
| ureq-proto | 0.6.0 | MIT OR Apache-2.0 | https://github.com/algesten/ureq-proto |
| url | 2.5.8 | MIT OR Apache-2.0 | https://github.com/servo/rust-url |
| urlencoding | 2.1.3 | MIT | https://github.com/kornelski/rust_urlencoding |
| usvg | 0.43.0 | MPL-2.0 | https://github.com/RazrFalcon/resvg |
| utf8_iter | 1.0.4 | Apache-2.0 OR MIT | https://github.com/hsivonen/utf8_iter |
| utf8-zero | 0.8.1 | MIT OR Apache-2.0 | https://github.com/algesten/utf8-zero |
| uuid | 1.23.1 | Apache-2.0 OR MIT | https://github.com/uuid-rs/uuid |
| vcpkg | 0.2.15 | MIT/Apache-2.0 | https://github.com/mcgoo/vcpkg-rs |
| version_check | 0.9.5 | MIT/Apache-2.0 | https://github.com/SergioBenitez/version_check |
| walkdir | 2.5.0 | Unlicense/MIT | https://github.com/BurntSushi/walkdir |
| want | 0.3.1 | MIT | https://github.com/seanmonstar/want |
| wasi | 0.11.1+wasi-snapshot-preview1 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | https://github.com/bytecodealliance/wasi |
| wasip2 | 1.0.3+wasi-0.2.9 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | https://github.com/bytecodealliance/wasi-rs |
| wasip3 | 0.4.0+wasi-0.3.0-rc-2026-01-06 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | https://github.com/bytecodealliance/wasi-rs |
| wasm-bindgen | 0.2.122 | MIT OR Apache-2.0 | https://github.com/wasm-bindgen/wasm-bindgen |
| wasm-bindgen-futures | 0.4.72 | MIT OR Apache-2.0 | https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/futures |
| wasm-bindgen-macro | 0.2.122 | MIT OR Apache-2.0 | https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/macro |
| wasm-bindgen-macro-support | 0.2.122 | MIT OR Apache-2.0 | https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/macro-support |
| wasm-bindgen-shared | 0.2.122 | MIT OR Apache-2.0 | https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/shared |
| wasm-encoder | 0.244.0 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | https://github.com/bytecodealliance/wasm-tools/tree/main/crates/wasm-encoder |
| wasm-metadata | 0.244.0 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | https://github.com/bytecodealliance/wasm-tools/tree/main/crates/wasm-metadata |
| wasm-streams | 0.4.2 | MIT OR Apache-2.0 | https://github.com/MattiasBuelens/wasm-streams/ |
| wasmi | 0.35.0 | MIT/Apache-2.0 | https://github.com/wasmi-labs/wasmi |
| wasmi_collections | 0.35.0 | MIT/Apache-2.0 | https://github.com/wasmi-labs/wasmi |
| wasmi_core | 0.35.0 | MIT/Apache-2.0 | https://github.com/wasmi-labs/wasmi |
| wasmparser | 0.244.0 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | https://github.com/bytecodealliance/wasm-tools/tree/main/crates/wasmparser |
| wasmparser-nostd | 0.100.2 | Apache-2.0 WITH LLVM-exception | https://github.com/bytecodealliance/wasm-tools/tree/main/crates/wasmparser |
| web-sys | 0.3.99 | MIT OR Apache-2.0 | https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/web-sys |
| web-time | 1.1.0 | MIT OR Apache-2.0 | https://github.com/daxpedda/web-time |
| webpki-root-certs | 1.0.7 | CDLA-Permissive-2.0 | https://github.com/rustls/webpki-roots |
| webpki-roots | 1.0.7 | CDLA-Permissive-2.0 | https://github.com/rustls/webpki-roots |
| weezl | 0.1.12 | MIT OR Apache-2.0 | https://github.com/image-rs/weezl |
| winapi | 0.3.9 | MIT/Apache-2.0 | https://github.com/retep998/winapi-rs |
| winapi-i686-pc-windows-gnu | 0.4.0 | MIT/Apache-2.0 | https://github.com/retep998/winapi-rs |
| winapi-util | 0.1.11 | Unlicense OR MIT | https://github.com/BurntSushi/winapi-util |
| winapi-x86_64-pc-windows-gnu | 0.4.0 | MIT/Apache-2.0 | https://github.com/retep998/winapi-rs |
| windows_aarch64_gnullvm | 0.48.5 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_aarch64_gnullvm | 0.52.6 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_aarch64_gnullvm | 0.53.1 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_aarch64_msvc | 0.48.5 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_aarch64_msvc | 0.52.6 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_aarch64_msvc | 0.53.1 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_i686_gnu | 0.48.5 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_i686_gnu | 0.52.6 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_i686_gnu | 0.53.1 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_i686_gnullvm | 0.52.6 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_i686_gnullvm | 0.53.1 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_i686_msvc | 0.48.5 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_i686_msvc | 0.52.6 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_i686_msvc | 0.53.1 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_x86_64_gnu | 0.48.5 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_x86_64_gnu | 0.52.6 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_x86_64_gnu | 0.53.1 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_x86_64_gnullvm | 0.48.5 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_x86_64_gnullvm | 0.52.6 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_x86_64_gnullvm | 0.53.1 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_x86_64_msvc | 0.48.5 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_x86_64_msvc | 0.52.6 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows_x86_64_msvc | 0.53.1 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows-core | 0.62.2 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows-implement | 0.60.2 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows-interface | 0.59.3 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows-link | 0.2.1 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows-result | 0.4.1 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows-strings | 0.5.1 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows-sys | 0.48.0 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows-sys | 0.52.0 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows-sys | 0.60.2 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows-sys | 0.61.2 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows-targets | 0.48.5 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows-targets | 0.52.6 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| windows-targets | 0.53.5 | MIT OR Apache-2.0 | https://github.com/microsoft/windows-rs |
| winnow | 0.7.15 | MIT | https://github.com/winnow-rs/winnow |
| wiremock | 0.6.5 | MIT/Apache-2.0 | https://github.com/LukeMathWalker/wiremock-rs |
| wit-bindgen | 0.51.0 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | https://github.com/bytecodealliance/wit-bindgen |
| wit-bindgen | 0.57.1 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | https://github.com/bytecodealliance/wit-bindgen |
| wit-bindgen-core | 0.51.0 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | https://github.com/bytecodealliance/wit-bindgen |
| wit-bindgen-rust | 0.51.0 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | https://github.com/bytecodealliance/wit-bindgen |
| wit-bindgen-rust-macro | 0.51.0 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | https://github.com/bytecodealliance/wit-bindgen |
| wit-component | 0.244.0 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | https://github.com/bytecodealliance/wasm-tools/tree/main/crates/wit-component |
| wit-parser | 0.244.0 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | https://github.com/bytecodealliance/wasm-tools/tree/main/crates/wit-parser |
| write-fonts | 0.43.0 | MIT OR Apache-2.0 | https://github.com/googlefonts/fontations |
| writeable | 0.5.5 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| writeable | 0.6.3 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| xattr | 1.6.1 | MIT OR Apache-2.0 | https://github.com/Stebalien/xattr |
| xmlparser | 0.13.6 | MIT/Apache-2.0 | https://github.com/RazrFalcon/xmlparser |
| xmlwriter | 0.1.0 | MIT | https://github.com/RazrFalcon/xmlwriter |
| xmp-writer | 0.3.3 | MIT OR Apache-2.0 | https://github.com/typst/xmp-writer |
| yaml-rust | 0.4.5 | MIT/Apache-2.0 | https://github.com/chyh1990/yaml-rust |
| yoke | 0.7.5 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| yoke | 0.8.2 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| yoke-derive | 0.7.5 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| yoke-derive | 0.8.2 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| zerocopy | 0.8.48 | BSD-2-Clause OR Apache-2.0 OR MIT | https://github.com/google/zerocopy |
| zerocopy-derive | 0.8.48 | BSD-2-Clause OR Apache-2.0 OR MIT | https://github.com/google/zerocopy |
| zerofrom | 0.1.8 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| zerofrom-derive | 0.1.7 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| zeroize | 1.8.2 | Apache-2.0 OR MIT | https://github.com/RustCrypto/utils |
| zeroize_derive | 1.4.3 | Apache-2.0 OR MIT | https://github.com/RustCrypto/utils/tree/master/zeroize/derive |
| zerotrie | 0.1.3 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| zerotrie | 0.2.4 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| zerovec | 0.10.4 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| zerovec | 0.11.6 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| zerovec-derive | 0.10.3 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| zerovec-derive | 0.11.3 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| zip | 0.6.6 | MIT | https://github.com/zip-rs/zip.git |
| zip | 2.4.2 | MIT | https://github.com/zip-rs/zip2.git |
| zip | 7.2.0 | MIT | https://github.com/zip-rs/zip2.git |
| zlib-rs | 0.6.3 | Zlib | https://github.com/trifectatechfoundation/zlib-rs |
| zmij | 1.0.21 | MIT | https://github.com/dtolnay/zmij |
| zopfli | 0.8.3 | Apache-2.0 | https://github.com/zopfli-rs/zopfli |
| zune-core | 0.4.12 | MIT OR Apache-2.0 OR Zlib |  |
| zune-core | 0.5.1 | MIT OR Apache-2.0 OR Zlib | https://github.com/etemesi254/zune-image |
| zune-jpeg | 0.4.21 | MIT OR Apache-2.0 OR Zlib | https://github.com/etemesi254/zune-image/tree/dev/crates/zune-jpeg |
| zune-jpeg | 0.5.15 | MIT OR Apache-2.0 OR Zlib | https://github.com/etemesi254/zune-image/tree/dev/crates/zune-jpeg |

## npm packages

| Package | Version | License | Repository |
| --- | --- | --- | --- |
| @adobe/css-tools | 4.4.4 | MIT | https://github.com/adobe/css-tools |
| @antfu/install-pkg | 1.1.0 | MIT | https://github.com/antfu/install-pkg |
| @asamuzakjp/css-color | 3.2.0 | MIT | https://github.com/asamuzaK/cssColor |
| @babel/code-frame | 7.29.0 | MIT | https://github.com/babel/babel |
| @babel/compat-data | 7.29.3 | MIT | https://github.com/babel/babel |
| @babel/core | 7.29.0 | MIT | https://github.com/babel/babel |
| @babel/generator | 7.29.1 | MIT | https://github.com/babel/babel |
| @babel/helper-compilation-targets | 7.28.6 | MIT | https://github.com/babel/babel |
| @babel/helper-globals | 7.28.0 | MIT | https://github.com/babel/babel |
| @babel/helper-module-imports | 7.28.6 | MIT | https://github.com/babel/babel |
| @babel/helper-module-transforms | 7.28.6 | MIT | https://github.com/babel/babel |
| @babel/helper-plugin-utils | 7.28.6 | MIT | https://github.com/babel/babel |
| @babel/helper-string-parser | 7.27.1 | MIT | https://github.com/babel/babel |
| @babel/helper-validator-identifier | 7.28.5 | MIT | https://github.com/babel/babel |
| @babel/helper-validator-option | 7.27.1 | MIT | https://github.com/babel/babel |
| @babel/helpers | 7.29.2 | MIT | https://github.com/babel/babel |
| @babel/parser | 7.29.3 | MIT | https://github.com/babel/babel |
| @babel/plugin-transform-react-jsx-self | 7.27.1 | MIT | https://github.com/babel/babel |
| @babel/plugin-transform-react-jsx-source | 7.27.1 | MIT | https://github.com/babel/babel |
| @babel/runtime | 7.29.2 | MIT | https://github.com/babel/babel |
| @babel/template | 7.28.6 | MIT | https://github.com/babel/babel |
| @babel/traverse | 7.29.0 | MIT | https://github.com/babel/babel |
| @babel/types | 7.29.0 | MIT | https://github.com/babel/babel |
| @braintree/sanitize-url | 7.1.2 | MIT | https://github.com/braintree/sanitize-url |
| @chevrotain/types | 11.1.2 | Apache-2.0 | git://github.com/Chevrotain/chevrotain |
| @csstools/color-helpers | 5.1.0 | MIT-0 | https://github.com/csstools/postcss-plugins |
| @csstools/css-calc | 2.1.4 | MIT | https://github.com/csstools/postcss-plugins |
| @csstools/css-color-parser | 3.1.0 | MIT | https://github.com/csstools/postcss-plugins |
| @csstools/css-parser-algorithms | 3.0.5 | MIT | https://github.com/csstools/postcss-plugins |
| @csstools/css-tokenizer | 3.0.4 | MIT | https://github.com/csstools/postcss-plugins |
| @csstools/postcss-is-pseudo-class | 5.0.3 | MIT-0 | https://github.com/csstools/postcss-plugins |
| @csstools/selector-resolve-nested | 3.1.0 | MIT-0 | https://github.com/csstools/postcss-plugins |
| @csstools/selector-specificity | 5.0.0 | MIT-0 | https://github.com/csstools/postcss-plugins |
| @develar/schema-utils | 2.6.5 | MIT | webpack/schema-utils |
| @electron/asar | 3.4.1 | MIT | https://github.com/electron/asar |
| @electron/get | 2.0.3 | MIT | https://github.com/electron/get |
| @electron/notarize | 2.5.0 | MIT | https://github.com/electron/notarize |
| @electron/osx-sign | 1.3.1 | BSD-2-Clause | https://github.com/electron/osx-sign |
| @electron/rebuild | 3.6.1 | MIT | https://github.com/electron/rebuild |
| @electron/universal | 2.0.1 | MIT | https://github.com/electron/universal |
| @esbuild/linux-x64 | 0.21.5 | MIT | https://github.com/evanw/esbuild |
| @eslint-community/eslint-utils | 4.9.1 | MIT | https://github.com/eslint-community/eslint-utils |
| @eslint-community/regexpp | 4.12.2 | MIT | https://github.com/eslint-community/regexpp |
| @eslint/config-array | 0.21.2 | Apache-2.0 | https://github.com/eslint/rewrite |
| @eslint/config-helpers | 0.4.2 | Apache-2.0 | https://github.com/eslint/rewrite |
| @eslint/core | 0.17.0 | Apache-2.0 | https://github.com/eslint/rewrite |
| @eslint/eslintrc | 2.1.4 | MIT | eslint/eslintrc |
| @eslint/eslintrc | 3.3.5 | MIT | eslint/eslintrc |
| @eslint/js | 8.57.1 | MIT | https://github.com/eslint/eslint |
| @eslint/js | 9.39.4 | MIT | https://github.com/eslint/eslint |
| @eslint/object-schema | 2.1.7 | Apache-2.0 | https://github.com/eslint/rewrite |
| @eslint/plugin-kit | 0.4.1 | Apache-2.0 | https://github.com/eslint/rewrite |
| @floating-ui/core | 1.7.5 | MIT | https://github.com/floating-ui/floating-ui |
| @floating-ui/dom | 1.7.6 | MIT | https://github.com/floating-ui/floating-ui |
| @floating-ui/utils | 0.2.11 | MIT | https://github.com/floating-ui/floating-ui |
| @gar/promisify | 1.1.3 | MIT | https://github.com/wraithgar/gar-promisify |
| @humanfs/core | 0.19.2 | Apache-2.0 | https://github.com/humanwhocodes/humanfs |
| @humanfs/node | 0.16.8 | Apache-2.0 | https://github.com/humanwhocodes/humanfs |
| @humanfs/types | 0.15.0 | Apache-2.0 | https://github.com/humanwhocodes/humanfs |
| @humanwhocodes/config-array | 0.13.0 | Apache-2.0 | https://github.com/humanwhocodes/config-array |
| @humanwhocodes/module-importer | 1.0.1 | Apache-2.0 | https://github.com/humanwhocodes/module-importer |
| @humanwhocodes/object-schema | 2.0.3 | BSD-3-Clause | https://github.com/humanwhocodes/object-schema |
| @humanwhocodes/retry | 0.4.3 | Apache-2.0 | https://github.com/humanwhocodes/retry |
| @iconify/types | 2.0.0 | MIT | https://github.com/iconify/iconify |
| @iconify/utils | 3.1.3 | MIT | https://github.com/iconify/iconify |
| @isaacs/cliui | 8.0.2 | ISC | yargs/cliui |
| @isaacs/fs-minipass | 4.0.1 | ISC | https://github.com/npm/fs-minipass |
| @jest/schemas | 29.6.3 | MIT | https://github.com/jestjs/jest |
| @jridgewell/gen-mapping | 0.3.13 | MIT | https://github.com/jridgewell/sourcemaps |
| @jridgewell/remapping | 2.3.5 | MIT | https://github.com/jridgewell/sourcemaps |
| @jridgewell/resolve-uri | 3.1.2 | MIT | https://github.com/jridgewell/resolve-uri |
| @jridgewell/sourcemap-codec | 1.5.5 | MIT | https://github.com/jridgewell/sourcemaps |
| @jridgewell/trace-mapping | 0.3.31 | MIT | https://github.com/jridgewell/sourcemaps |
| @malept/cross-spawn-promise | 2.0.0 | Apache-2.0 | https://github.com/malept/cross-spawn-promise |
| @malept/flatpak-bundler | 0.4.0 | MIT | https://github.com/malept/flatpak-bundler |
| @marp-team/marp-cli | 4.4.0 | MIT | https://github.com/marp-team/marp-cli |
| @marp-team/marp-core | 4.3.0 | MIT | https://github.com/marp-team/marp-core |
| @marp-team/marpit | 3.2.1 | MIT | https://github.com/marp-team/marpit |
| @marp-team/marpit-svg-polyfill | 2.1.0 | MIT | https://github.com/marp-team/marpit-svg-polyfill |
| @mermaid-js/parser | 1.1.1 | MIT | https://github.com/mermaid-js/mermaid |
| @nodelib/fs.scandir | 2.1.5 | MIT | https://github.com/nodelib/nodelib/tree/master/packages/fs/fs.scandir |
| @nodelib/fs.stat | 2.0.5 | MIT | https://github.com/nodelib/nodelib/tree/master/packages/fs/fs.stat |
| @nodelib/fs.walk | 1.2.8 | MIT | https://github.com/nodelib/nodelib/tree/master/packages/fs/fs.walk |
| @npmcli/fs | 2.1.2 | ISC | https://github.com/npm/fs |
| @npmcli/move-file | 2.0.1 | MIT | https://github.com/npm/move-file |
| @phosphor-icons/react | 2.1.10 | MIT | phosphor-icons/react |
| @pkgjs/parseargs | 0.11.0 | MIT | git@github.com:pkgjs/parseargs |
| @puppeteer/browsers | 2.13.2 | Apache-2.0 | https://github.com/puppeteer/puppeteer/tree/main/packages/browsers |
| @remix-run/router | 1.23.2 | MIT | https://github.com/remix-run/react-router |
| @rolldown/pluginutils | 1.0.0-beta.27 | MIT | https://github.com/rolldown/rolldown |
| @rollup/rollup-linux-x64-gnu | 4.60.4 | MIT | https://github.com/rollup/rollup |
| @rollup/rollup-linux-x64-musl | 4.60.4 | MIT | https://github.com/rollup/rollup |
| @sinclair/typebox | 0.27.10 | MIT | https://github.com/sinclairzx81/typebox-legacy |
| @sindresorhus/is | 4.6.0 | MIT | sindresorhus/is |
| @szmarczak/http-timer | 4.0.6 | MIT | https://github.com/szmarczak/http-timer |
| @tessera/desktop | 0.1.0 | MIT |  |
| @testing-library/dom | 10.4.1 | MIT | https://github.com/testing-library/dom-testing-library |
| @testing-library/jest-dom | 6.9.1 | MIT | https://github.com/testing-library/jest-dom |
| @testing-library/react | 16.3.2 | MIT | https://github.com/testing-library/react-testing-library |
| @testing-library/user-event | 14.6.1 | MIT | https://github.com/testing-library/user-event |
| @tiptap/core | 3.23.6 | MIT | https://github.com/ueberdosis/tiptap |
| @tiptap/extension-blockquote | 3.23.6 | MIT | https://github.com/ueberdosis/tiptap |
| @tiptap/extension-bold | 3.23.6 | MIT | https://github.com/ueberdosis/tiptap |
| @tiptap/extension-bubble-menu | 3.23.6 | MIT | https://github.com/ueberdosis/tiptap |
| @tiptap/extension-bullet-list | 3.23.6 | MIT | https://github.com/ueberdosis/tiptap |
| @tiptap/extension-character-count | 3.23.6 | MIT | https://github.com/ueberdosis/tiptap |
| @tiptap/extension-code | 3.23.6 | MIT | https://github.com/ueberdosis/tiptap |
| @tiptap/extension-code-block | 3.23.6 | MIT | https://github.com/ueberdosis/tiptap |
| @tiptap/extension-code-block-lowlight | 3.23.6 | MIT | https://github.com/ueberdosis/tiptap |
| @tiptap/extension-document | 3.23.6 | MIT | https://github.com/ueberdosis/tiptap |
| @tiptap/extension-dropcursor | 3.23.6 | MIT | https://github.com/ueberdosis/tiptap |
| @tiptap/extension-floating-menu | 3.23.6 | MIT | https://github.com/ueberdosis/tiptap |
| @tiptap/extension-gapcursor | 3.23.6 | MIT | https://github.com/ueberdosis/tiptap |
| @tiptap/extension-hard-break | 3.23.6 | MIT | https://github.com/ueberdosis/tiptap |
| @tiptap/extension-heading | 3.23.6 | MIT | https://github.com/ueberdosis/tiptap |
| @tiptap/extension-horizontal-rule | 3.23.6 | MIT | https://github.com/ueberdosis/tiptap |
| @tiptap/extension-image | 3.23.6 | MIT | https://github.com/ueberdosis/tiptap |
| @tiptap/extension-italic | 3.23.6 | MIT | https://github.com/ueberdosis/tiptap |
| @tiptap/extension-link | 3.23.6 | MIT | https://github.com/ueberdosis/tiptap |
| @tiptap/extension-list | 3.23.6 | MIT | https://github.com/ueberdosis/tiptap |
| @tiptap/extension-list-item | 3.23.6 | MIT | https://github.com/ueberdosis/tiptap |
| @tiptap/extension-list-keymap | 3.23.6 | MIT | https://github.com/ueberdosis/tiptap |
| @tiptap/extension-ordered-list | 3.23.6 | MIT | https://github.com/ueberdosis/tiptap |
| @tiptap/extension-paragraph | 3.23.6 | MIT | https://github.com/ueberdosis/tiptap |
| @tiptap/extension-placeholder | 3.23.6 | MIT | https://github.com/ueberdosis/tiptap |
| @tiptap/extension-strike | 3.23.6 | MIT | https://github.com/ueberdosis/tiptap |
| @tiptap/extension-table | 3.23.6 | MIT | https://github.com/ueberdosis/tiptap |
| @tiptap/extension-table-cell | 3.23.6 | MIT | https://github.com/ueberdosis/tiptap |
| @tiptap/extension-table-header | 3.23.6 | MIT | https://github.com/ueberdosis/tiptap |
| @tiptap/extension-table-row | 3.23.6 | MIT | https://github.com/ueberdosis/tiptap |
| @tiptap/extension-task-item | 3.23.6 | MIT | https://github.com/ueberdosis/tiptap |
| @tiptap/extension-task-list | 3.23.6 | MIT | https://github.com/ueberdosis/tiptap |
| @tiptap/extension-text | 3.23.6 | MIT | https://github.com/ueberdosis/tiptap |
| @tiptap/extension-underline | 3.23.6 | MIT | https://github.com/ueberdosis/tiptap |
| @tiptap/extensions | 3.23.6 | MIT | https://github.com/ueberdosis/tiptap |
| @tiptap/pm | 3.23.6 | MIT | https://github.com/ueberdosis/tiptap |
| @tiptap/react | 3.23.6 | MIT | https://github.com/ueberdosis/tiptap |
| @tiptap/starter-kit | 3.23.6 | MIT | https://github.com/ueberdosis/tiptap |
| @tootallnate/once | 2.0.1 | MIT | https://github.com/TooTallNate/once |
| @tootallnate/quickjs-emscripten | 0.23.0 | MIT | https://github.com/justjake/quickjs-emscripten |
| @types/aria-query | 5.0.4 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/babel__core | 7.20.5 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/babel__generator | 7.27.0 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/babel__template | 7.4.4 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/babel__traverse | 7.28.0 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/cacheable-request | 6.0.3 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3 | 7.4.3 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-array | 3.2.2 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-axis | 3.0.6 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-brush | 3.0.6 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-chord | 3.0.6 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-color | 3.1.3 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-contour | 3.0.6 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-delaunay | 6.0.4 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-dispatch | 3.0.7 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-drag | 3.0.7 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-dsv | 3.0.7 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-ease | 3.0.2 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-fetch | 3.0.7 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-force | 3.0.10 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-format | 3.0.4 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-geo | 3.1.0 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-hierarchy | 3.1.7 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-interpolate | 3.0.4 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-path | 3.1.1 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-polygon | 3.0.2 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-quadtree | 3.0.6 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-random | 3.0.3 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-scale | 4.0.9 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-scale-chromatic | 3.1.0 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-selection | 3.0.11 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-shape | 3.1.8 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-time | 3.0.4 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-time-format | 4.0.3 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-timer | 3.0.2 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-transition | 3.0.9 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/d3-zoom | 3.0.8 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/debug | 4.1.13 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/estree | 1.0.8 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/fs-extra | 9.0.13 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/geojson | 7946.0.16 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/hast | 3.0.4 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/http-cache-semantics | 4.2.0 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/json-schema | 7.0.15 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/keyv | 3.1.4 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/ms | 2.1.0 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/node | 20.19.41 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/prop-types | 15.7.15 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/react | 18.3.28 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/react-dom | 18.3.7 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/responselike | 1.0.3 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/trusted-types | 2.0.7 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/unist | 3.0.3 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/use-sync-external-store | 0.0.6 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/yauzl | 2.10.3 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @typescript-eslint/eslint-plugin | 8.60.0 | MIT | https://github.com/typescript-eslint/typescript-eslint |
| @typescript-eslint/parser | 8.60.0 | MIT | https://github.com/typescript-eslint/typescript-eslint |
| @typescript-eslint/project-service | 8.60.0 | MIT | https://github.com/typescript-eslint/typescript-eslint |
| @typescript-eslint/scope-manager | 8.60.0 | MIT | https://github.com/typescript-eslint/typescript-eslint |
| @typescript-eslint/tsconfig-utils | 8.60.0 | MIT | https://github.com/typescript-eslint/typescript-eslint |
| @typescript-eslint/type-utils | 8.60.0 | MIT | https://github.com/typescript-eslint/typescript-eslint |
| @typescript-eslint/types | 8.60.0 | MIT | https://github.com/typescript-eslint/typescript-eslint |
| @typescript-eslint/typescript-estree | 8.60.0 | MIT | https://github.com/typescript-eslint/typescript-eslint |
| @typescript-eslint/utils | 8.60.0 | MIT | https://github.com/typescript-eslint/typescript-eslint |
| @typescript-eslint/visitor-keys | 8.60.0 | MIT | https://github.com/typescript-eslint/typescript-eslint |
| @ungap/structured-clone | 1.3.1 | ISC | https://github.com/ungap/structured-clone |
| @upsetjs/venn.js | 2.0.0 | MIT | https://github.com/upsetjs/venn.js |
| @vitejs/plugin-react | 4.7.0 | MIT | https://github.com/vitejs/vite-plugin-react |
| @vitest/expect | 1.6.1 | MIT | https://github.com/vitest-dev/vitest |
| @vitest/runner | 1.6.1 | MIT | https://github.com/vitest-dev/vitest |
| @vitest/snapshot | 1.6.1 | MIT | https://github.com/vitest-dev/vitest |
| @vitest/spy | 1.6.1 | MIT | https://github.com/vitest-dev/vitest |
| @vitest/utils | 1.6.1 | MIT | https://github.com/vitest-dev/vitest |
| @xmldom/xmldom | 0.9.10 | MIT | git://github.com/xmldom/xmldom |
| 7zip-bin | 5.2.0 | MIT | develar/7zip-bin |
| abbrev | 1.1.1 | ISC | http://github.com/isaacs/abbrev-js |
| accepts | 1.3.8 | MIT | jshttp/accepts |
| acorn | 8.16.0 | MIT | https://github.com/acornjs/acorn |
| acorn-jsx | 5.3.2 | MIT | https://github.com/acornjs/acorn-jsx |
| acorn-walk | 8.3.5 | MIT | https://github.com/acornjs/acorn |
| agent-base | 6.0.2 | MIT | git://github.com/TooTallNate/node-agent-base |
| agent-base | 7.1.4 | MIT | https://github.com/TooTallNate/proxy-agents |
| agentkeepalive | 4.6.0 | MIT | git://github.com/node-modules/agentkeepalive |
| aggregate-error | 3.1.0 | MIT | sindresorhus/aggregate-error |
| ajv | 6.15.0 | MIT | https://github.com/ajv-validator/ajv |
| ajv-keywords | 3.5.2 | MIT | https://github.com/epoberezkin/ajv-keywords |
| ansi-regex | 5.0.1 | MIT | chalk/ansi-regex |
| ansi-regex | 6.2.2 | MIT | chalk/ansi-regex |
| ansi-styles | 4.3.0 | MIT | chalk/ansi-styles |
| ansi-styles | 5.2.0 | MIT | chalk/ansi-styles |
| ansi-styles | 6.2.3 | MIT | chalk/ansi-styles |
| app-builder-bin | 5.0.0-alpha.10 | MIT | develar/app-builder |
| app-builder-lib | 25.1.8 | MIT | https://github.com/electron-userland/electron-builder |
| aproba | 2.1.0 | ISC | https://github.com/iarna/aproba |
| archiver | 5.3.2 | MIT | https://github.com/archiverjs/node-archiver |
| archiver-utils | 2.1.0 | MIT | https://github.com/archiverjs/archiver-utils |
| archiver-utils | 3.0.4 | MIT | https://github.com/archiverjs/archiver-utils |
| are-we-there-yet | 3.0.1 | ISC | https://github.com/npm/are-we-there-yet |
| argparse | 2.0.1 | Python-2.0 | nodeca/argparse |
| aria-query | 5.3.0 | Apache-2.0 | https://github.com/A11yance/aria-query |
| assertion-error | 1.1.0 | MIT | git@github.com:chaijs/assertion-error |
| ast-types | 0.13.4 | MIT | git://github.com/benjamn/ast-types |
| async | 3.2.6 | MIT | https://github.com/caolan/async |
| async-exit-hook | 2.0.1 | MIT | https://github.com/tapppi/async-exit-hook |
| asynckit | 0.4.0 | MIT | https://github.com/alexindigo/asynckit |
| at-least-node | 1.0.0 | ISC | https://github.com/RyanZim/at-least-node |
| b4a | 1.8.1 | Apache-2.0 | https://github.com/holepunchto/b4a |
| balanced-match | 1.0.2 | MIT | git://github.com/juliangruber/balanced-match |
| balanced-match | 4.0.4 | MIT | git://github.com/juliangruber/balanced-match |
| bare-events | 2.8.3 | Apache-2.0 | https://github.com/holepunchto/bare-events |
| bare-fs | 4.7.1 | Apache-2.0 | https://github.com/holepunchto/bare-fs |
| bare-os | 3.9.1 | Apache-2.0 | https://github.com/holepunchto/bare-os |
| bare-path | 3.0.0 | Apache-2.0 | https://github.com/holepunchto/bare-path |
| bare-stream | 2.13.1 | Apache-2.0 | https://github.com/holepunchto/bare-stream |
| bare-url | 2.4.3 | Apache-2.0 | https://github.com/holepunchto/bare-url |
| base64-js | 1.5.1 | MIT | git://github.com/beatgammit/base64-js |
| baseline-browser-mapping | 2.10.31 | Apache-2.0 | https://github.com/web-platform-dx/baseline-browser-mapping |
| basic-ftp | 5.3.1 | MIT | https://github.com/patrickjuchli/basic-ftp |
| batch | 0.6.1 | MIT | https://github.com/visionmedia/batch |
| bl | 4.1.0 | MIT | https://github.com/rvagg/bl |
| bluebird | 3.7.2 | MIT | git://github.com/petkaantonov/bluebird |
| bluebird-lst | 1.0.9 | MIT | develar/fs-extra-p |
| boolean | 3.2.0 | MIT | git://github.com/thenativeweb/boolean |
| brace-expansion | 1.1.14 | MIT | git://github.com/juliangruber/brace-expansion |
| brace-expansion | 1.1.15 | MIT | git://github.com/juliangruber/brace-expansion |
| brace-expansion | 2.1.0 | MIT | git://github.com/juliangruber/brace-expansion |
| brace-expansion | 5.0.6 | MIT | ssh://git@github.com/juliangruber/brace-expansion |
| browserslist | 4.28.2 | MIT | browserslist/browserslist |
| buffer | 5.7.1 | MIT | git://github.com/feross/buffer |
| buffer-crc32 | 0.2.13 | MIT | git://github.com/brianloveswords/buffer-crc32 |
| buffer-from | 1.1.2 | MIT | LinusU/buffer-from |
| builder-util | 25.1.7 | MIT | https://github.com/electron-userland/electron-builder |
| builder-util-runtime | 9.2.10 | MIT | https://github.com/electron-userland/electron-builder |
| builder-util-runtime | 9.5.1 | MIT | https://github.com/electron-userland/electron-builder |
| cac | 6.7.14 | MIT | egoist/cac |
| cacache | 16.1.3 | ISC | https://github.com/npm/cacache |
| cacheable-lookup | 5.0.4 | MIT | https://github.com/szmarczak/cacheable-lookup |
| cacheable-request | 7.0.4 | MIT | lukechilds/cacheable-request |
| call-bind-apply-helpers | 1.0.2 | MIT | https://github.com/ljharb/call-bind-apply-helpers |
| callsites | 3.1.0 | MIT | sindresorhus/callsites |
| caniuse-lite | 1.0.30001793 | CC-BY-4.0 | browserslist/caniuse-lite |
| chai | 4.5.0 | MIT | https://github.com/chaijs/chai |
| chalk | 4.1.2 | MIT | chalk/chalk |
| check-error | 1.0.3 | MIT | ssh://git@github.com/chaijs/check-error |
| chokidar | 4.0.3 | MIT | https://github.com/paulmillr/chokidar |
| chownr | 2.0.0 | ISC | git://github.com/isaacs/chownr |
| chownr | 3.0.0 | BlueOak-1.0.0 | git://github.com/isaacs/chownr |
| chromium-bidi | 14.0.0 | Apache-2.0 | https://github.com/GoogleChromeLabs/chromium-bidi |
| chromium-pickle-js | 0.2.0 | MIT | https://github.com/electron/node-chromium-pickle-js |
| ci-info | 3.9.0 | MIT | https://github.com/watson/ci-info.git |
| clean-stack | 2.2.0 | MIT | sindresorhus/clean-stack |
| cli-cursor | 3.1.0 | MIT | sindresorhus/cli-cursor |
| cli-spinners | 2.9.2 | MIT | sindresorhus/cli-spinners |
| cliui | 8.0.1 | ISC | yargs/cliui |
| clone | 1.0.4 | MIT | git://github.com/pvorb/node-clone |
| clone-response | 1.0.3 | MIT | https://github.com/sindresorhus/clone-response |
| color-convert | 2.0.1 | MIT | Qix-/color-convert |
| color-name | 1.1.4 | MIT | git@github.com:colorjs/color-name |
| color-support | 1.1.3 | ISC | https://github.com/isaacs/color-support |
| combined-stream | 1.0.8 | MIT | git://github.com/felixge/node-combined-stream |
| commander | 13.1.0 | MIT | https://github.com/tj/commander.js |
| commander | 2.20.3 | MIT | https://github.com/tj/commander.js |
| commander | 5.1.0 | MIT | https://github.com/tj/commander.js |
| commander | 7.2.0 | MIT | https://github.com/tj/commander.js |
| commander | 8.3.0 | MIT | https://github.com/tj/commander.js |
| compare-version | 0.1.2 | MIT | kevva/compare-version |
| compress-commons | 4.1.2 | MIT | https://github.com/archiverjs/node-compress-commons |
| concat-map | 0.0.1 | MIT | git://github.com/substack/node-concat-map |
| confbox | 0.1.8 | MIT | unjs/confbox |
| config-file-ts | 0.2.8-rc1 | MIT | https://github.com/mighdoll/config-file-ts |
| console-control-strings | 1.1.0 | ISC | https://github.com/iarna/console-control-strings |
| convert-source-map | 2.0.0 | MIT | git://github.com/thlorenz/convert-source-map |
| core-util-is | 1.0.2 | MIT | git://github.com/isaacs/core-util-is |
| cose-base | 1.0.3 | MIT | https://github.com/iVis-at-Bilkent/cose-base |
| cose-base | 2.2.0 | MIT | https://github.com/iVis-at-Bilkent/cose-base |
| cosmiconfig | 9.0.1 | MIT | https://github.com/cosmiconfig/cosmiconfig |
| crc-32 | 1.2.2 | Apache-2.0 | git://github.com/SheetJS/js-crc32 |
| crc32-stream | 4.0.3 | MIT | https://github.com/archiverjs/node-crc32-stream |
| cross-spawn | 7.0.6 | MIT | git@github.com:moxystudio/node-cross-spawn |
| css.escape | 1.5.1 | MIT | https://github.com/mathiasbynens/CSS.escape |
| cssesc | 3.0.0 | MIT | https://github.com/mathiasbynens/cssesc |
| cssfilter | 0.0.10 | MIT | https://github.com/leizongmin/js-css-filter |
| cssstyle | 4.6.0 | MIT | jsdom/cssstyle |
| csstype | 3.2.3 | MIT | https://github.com/frenic/csstype |
| cytoscape | 3.33.4 | MIT | https://github.com/cytoscape/cytoscape.js |
| cytoscape-cose-bilkent | 4.1.0 | MIT | https://github.com/cytoscape/cytoscape.js-cose-bilkent |
| cytoscape-fcose | 2.2.0 | MIT | https://github.com/iVis-at-Bilkent/cytoscape.js-fcose |
| d3 | 7.9.0 | ISC | https://github.com/d3/d3 |
| d3-array | 2.12.1 | BSD-3-Clause | https://github.com/d3/d3-array |
| d3-array | 3.2.4 | ISC | https://github.com/d3/d3-array |
| d3-axis | 3.0.0 | ISC | https://github.com/d3/d3-axis |
| d3-brush | 3.0.0 | ISC | https://github.com/d3/d3-brush |
| d3-chord | 3.0.1 | ISC | https://github.com/d3/d3-chord |
| d3-color | 3.1.0 | ISC | https://github.com/d3/d3-color |
| d3-contour | 4.0.2 | ISC | https://github.com/d3/d3-contour |
| d3-delaunay | 6.0.4 | ISC | https://github.com/d3/d3-delaunay |
| d3-dispatch | 3.0.1 | ISC | https://github.com/d3/d3-dispatch |
| d3-drag | 3.0.0 | ISC | https://github.com/d3/d3-drag |
| d3-dsv | 3.0.1 | ISC | https://github.com/d3/d3-dsv |
| d3-ease | 3.0.1 | BSD-3-Clause | https://github.com/d3/d3-ease |
| d3-fetch | 3.0.1 | ISC | https://github.com/d3/d3-fetch |
| d3-force | 3.0.0 | ISC | https://github.com/d3/d3-force |
| d3-format | 3.1.2 | ISC | https://github.com/d3/d3-format |
| d3-geo | 3.1.1 | ISC | https://github.com/d3/d3-geo |
| d3-hierarchy | 3.1.2 | ISC | https://github.com/d3/d3-hierarchy |
| d3-interpolate | 3.0.1 | ISC | https://github.com/d3/d3-interpolate |
| d3-path | 1.0.9 | BSD-3-Clause | https://github.com/d3/d3-path |
| d3-path | 3.1.0 | ISC | https://github.com/d3/d3-path |
| d3-polygon | 3.0.1 | ISC | https://github.com/d3/d3-polygon |
| d3-quadtree | 3.0.1 | ISC | https://github.com/d3/d3-quadtree |
| d3-random | 3.0.1 | ISC | https://github.com/d3/d3-random |
| d3-sankey | 0.12.3 | BSD-3-Clause | https://github.com/d3/d3-sankey |
| d3-scale | 4.0.2 | ISC | https://github.com/d3/d3-scale |
| d3-scale-chromatic | 3.1.0 | ISC | https://github.com/d3/d3-scale-chromatic |
| d3-selection | 3.0.0 | ISC | https://github.com/d3/d3-selection |
| d3-shape | 1.3.7 | BSD-3-Clause | https://github.com/d3/d3-shape |
| d3-shape | 3.2.0 | ISC | https://github.com/d3/d3-shape |
| d3-time | 3.1.0 | ISC | https://github.com/d3/d3-time |
| d3-time-format | 4.1.0 | ISC | https://github.com/d3/d3-time-format |
| d3-timer | 3.0.1 | ISC | https://github.com/d3/d3-timer |
| d3-transition | 3.0.1 | ISC | https://github.com/d3/d3-transition |
| d3-zoom | 3.0.0 | ISC | https://github.com/d3/d3-zoom |
| dagre-d3-es | 7.0.14 | MIT | https://github.com/tbo47/dagre-es |
| data-uri-to-buffer | 6.0.2 | MIT | https://github.com/TooTallNate/proxy-agents |
| data-urls | 5.0.0 | MIT | jsdom/data-urls |
| dayjs | 1.11.20 | MIT | https://github.com/iamkun/dayjs |
| debug | 2.6.9 | MIT | git://github.com/visionmedia/debug |
| debug | 4.4.3 | MIT | git://github.com/debug-js/debug |
| decimal.js | 10.6.0 | MIT | https://github.com/MikeMcl/decimal.js |
| decompress-response | 6.0.0 | MIT | sindresorhus/decompress-response |
| deep-eql | 4.1.4 | MIT | git@github.com:chaijs/deep-eql |
| deep-is | 0.1.4 | MIT | http://github.com/thlorenz/deep-is |
| defaults | 1.0.4 | MIT | git://github.com/sindresorhus/node-defaults |
| defer-to-connect | 2.0.1 | MIT | https://github.com/szmarczak/defer-to-connect |
| define-data-property | 1.1.4 | MIT | https://github.com/ljharb/define-data-property |
| define-properties | 1.2.1 | MIT | git://github.com/ljharb/define-properties |
| degenerator | 5.0.1 | MIT | https://github.com/TooTallNate/proxy-agents |
| delaunator | 5.1.0 | ISC | https://github.com/mapbox/delaunator |
| delayed-stream | 1.0.0 | MIT | git://github.com/felixge/node-delayed-stream |
| delegates | 1.0.0 | MIT | visionmedia/node-delegates |
| depd | 1.1.2 | MIT | dougwilson/nodejs-depd |
| dequal | 2.0.3 | MIT | lukeed/dequal |
| detect-libc | 2.1.2 | Apache-2.0 | git://github.com/lovell/detect-libc |
| detect-node | 2.1.0 | MIT | https://github.com/iliakan/detect-node |
| devlop | 1.1.0 | MIT | wooorm/devlop |
| devtools-protocol | 0.0.1608973 | BSD-3-Clause | https://github.com/ChromeDevTools/devtools-protocol |
| diff-sequences | 29.6.3 | MIT | https://github.com/jestjs/jest |
| dir-compare | 4.2.0 | MIT | https://github.com/gliviu/dir-compare |
| dmg-builder | 25.1.8 | MIT | https://github.com/electron-userland/electron-builder |
| doctrine | 3.0.0 | Apache-2.0 | eslint/doctrine |
| dom-accessibility-api | 0.5.16 | MIT | https://github.com/eps1lon/dom-accessibility-api |
| dom-accessibility-api | 0.6.3 | MIT | https://github.com/eps1lon/dom-accessibility-api |
| dompurify | 3.4.5 | (MPL-2.0 OR Apache-2.0) | git://github.com/cure53/DOMPurify |
| dotenv | 16.6.1 | BSD-2-Clause | git://github.com/motdotla/dotenv |
| dotenv-expand | 11.0.7 | BSD-2-Clause | https://github.com/motdotla/dotenv-expand |
| dunder-proto | 1.0.1 | MIT | https://github.com/es-shims/dunder-proto |
| eastasianwidth | 0.2.0 | MIT | git://github.com/komagata/eastasianwidth.git |
| ejs | 3.1.10 | Apache-2.0 | git://github.com/mde/ejs |
| electron | 31.7.7 | MIT | https://github.com/electron/electron |
| electron-builder | 25.1.8 | MIT | https://github.com/electron-userland/electron-builder |
| electron-builder-squirrel-windows | 25.1.8 | MIT | https://github.com/electron-userland/electron-builder |
| electron-publish | 25.1.7 | MIT | https://github.com/electron-userland/electron-builder |
| electron-to-chromium | 1.5.359 | ISC | https://github.com/Kilian/electron-to-chromium |
| electron-updater | 6.8.3 | MIT | https://github.com/electron-userland/electron-builder |
| emoji-regex | 8.0.0 | MIT | https://github.com/mathiasbynens/emoji-regex |
| emoji-regex | 9.2.2 | MIT | https://github.com/mathiasbynens/emoji-regex |
| encoding | 0.1.13 | MIT | https://github.com/andris9/encoding.git |
| end-of-stream | 1.4.5 | MIT | git://github.com/mafintosh/end-of-stream |
| entities | 4.5.0 | BSD-2-Clause | git://github.com/fb55/entities |
| entities | 6.0.1 | BSD-2-Clause | git://github.com/fb55/entities |
| env-paths | 2.2.1 | MIT | sindresorhus/env-paths |
| err-code | 2.0.3 | MIT | git://github.com/IndigoUnited/js-err-code |
| error-ex | 1.3.4 | MIT | qix-/node-error-ex |
| es-define-property | 1.0.1 | MIT | https://github.com/ljharb/es-define-property |
| es-errors | 1.3.0 | MIT | https://github.com/ljharb/es-errors |
| es-object-atoms | 1.1.1 | MIT | https://github.com/ljharb/es-object-atoms |
| es-set-tostringtag | 2.1.0 | MIT | https://github.com/es-shims/es-set-tostringtag |
| es-toolkit | 1.46.1 | MIT | https://github.com/toss/es-toolkit |
| es6-error | 4.1.1 | MIT | https://github.com/bjyoungblood/es6-error |
| esbuild | 0.21.5 | MIT | https://github.com/evanw/esbuild |
| escalade | 3.2.0 | MIT | lukeed/escalade |
| escape-html | 1.0.3 | MIT | component/escape-html |
| escape-string-regexp | 4.0.0 | MIT | sindresorhus/escape-string-regexp |
| escodegen | 2.1.0 | BSD-2-Clause | http://github.com/estools/escodegen |
| eslint | 8.57.1 | MIT | eslint/eslint |
| eslint | 9.39.4 | MIT | eslint/eslint |
| eslint-plugin-react-hooks | 5.2.0 | MIT | https://github.com/facebook/react |
| eslint-plugin-react-refresh | 0.4.26 | MIT | github:ArnaudBarre/eslint-plugin-react-refresh |
| eslint-scope | 7.2.2 | BSD-2-Clause | eslint/eslint-scope |
| eslint-scope | 8.4.0 | BSD-2-Clause | https://github.com/eslint/js |
| eslint-visitor-keys | 3.4.3 | Apache-2.0 | eslint/eslint-visitor-keys |
| eslint-visitor-keys | 4.2.1 | Apache-2.0 | https://github.com/eslint/js |
| eslint-visitor-keys | 5.0.1 | Apache-2.0 | https://github.com/eslint/js |
| esm | 3.2.25 | MIT | standard-things/esm |
| espree | 10.4.0 | BSD-2-Clause | https://github.com/eslint/js |
| espree | 9.6.1 | BSD-2-Clause | eslint/espree |
| esprima | 4.0.1 | BSD-2-Clause | https://github.com/jquery/esprima |
| esquery | 1.7.0 | BSD-3-Clause | https://github.com/estools/esquery |
| esrecurse | 4.3.0 | BSD-2-Clause | https://github.com/estools/esrecurse |
| estraverse | 5.3.0 | BSD-2-Clause | http://github.com/estools/estraverse |
| estree-walker | 3.0.3 | MIT | https://github.com/Rich-Harris/estree-walker |
| esutils | 2.0.3 | BSD-2-Clause | http://github.com/estools/esutils |
| events-universal | 1.0.1 | Apache-2.0 | https://github.com/holepunchto/events-universal |
| execa | 8.0.1 | MIT | sindresorhus/execa |
| exponential-backoff | 3.1.3 | Apache-2.0 | https://github.com/coveooss/exponential-backoff |
| extract-zip | 2.0.1 | BSD-2-Clause | maxogden/extract-zip |
| fast-deep-equal | 3.1.3 | MIT | https://github.com/epoberezkin/fast-deep-equal |
| fast-equals | 5.4.0 | MIT | https://github.com/planttheidea/fast-equals |
| fast-fifo | 1.3.2 | MIT | https://github.com/mafintosh/fast-fifo |
| fast-json-stable-stringify | 2.1.0 | MIT | git://github.com/epoberezkin/fast-json-stable-stringify |
| fast-levenshtein | 2.0.6 | MIT | https://github.com/hiddentao/fast-levenshtein |
| fastq | 1.20.1 | ISC | https://github.com/mcollina/fastq |
| fd-slicer | 1.1.0 | MIT | git://github.com/andrewrk/node-fd-slicer |
| fdir | 6.5.0 | MIT | https://github.com/thecodrr/fdir |
| file-entry-cache | 6.0.1 | MIT | royriojas/file-entry-cache |
| file-entry-cache | 8.0.0 | MIT | jaredwray/file-entry-cache |
| filelist | 1.0.6 | Apache-2.0 | git://github.com/mde/filelist |
| find-up | 5.0.0 | MIT | sindresorhus/find-up |
| flat-cache | 3.2.0 | MIT | jaredwray/flat-cache |
| flat-cache | 4.0.1 | MIT | jaredwray/flat-cache |
| flatted | 3.4.2 | ISC | https://github.com/WebReflection/flatted |
| foreground-child | 3.3.1 | ISC | https://github.com/tapjs/foreground-child |
| form-data | 4.0.5 | MIT | git://github.com/form-data/form-data |
| fs-constants | 1.0.0 | MIT | https://github.com/mafintosh/fs-constants |
| fs-extra | 10.1.0 | MIT | https://github.com/jprichardson/node-fs-extra |
| fs-extra | 11.3.5 | MIT | https://github.com/jprichardson/node-fs-extra |
| fs-extra | 8.1.0 | MIT | https://github.com/jprichardson/node-fs-extra |
| fs-extra | 9.1.0 | MIT | https://github.com/jprichardson/node-fs-extra |
| fs-minipass | 2.1.0 | ISC | https://github.com/npm/fs-minipass |
| fs.realpath | 1.0.0 | ISC | https://github.com/isaacs/fs.realpath |
| function-bind | 1.1.2 | MIT | https://github.com/Raynos/function-bind |
| gauge | 4.0.4 | ISC | https://github.com/npm/gauge |
| gensync | 1.0.0-beta.2 | MIT | https://github.com/loganfsmyth/gensync |
| get-caller-file | 2.0.5 | ISC | https://github.com/stefanpenner/get-caller-file |
| get-func-name | 2.0.2 | MIT | ssh://git@github.com/chaijs/get-func-name |
| get-intrinsic | 1.3.0 | MIT | https://github.com/ljharb/get-intrinsic |
| get-proto | 1.0.1 | MIT | https://github.com/ljharb/get-proto |
| get-stream | 5.2.0 | MIT | sindresorhus/get-stream |
| get-stream | 8.0.1 | MIT | sindresorhus/get-stream |
| get-uri | 6.0.5 | MIT | https://github.com/TooTallNate/proxy-agents |
| glob | 10.5.0 | ISC | git://github.com/isaacs/node-glob |
| glob | 7.2.3 | ISC | git://github.com/isaacs/node-glob |
| glob | 8.1.0 | ISC | git://github.com/isaacs/node-glob |
| glob-parent | 6.0.2 | ISC | gulpjs/glob-parent |
| global-agent | 3.0.0 | BSD-3-Clause | https://github.com/gajus/global-agent |
| globals | 13.24.0 | MIT | sindresorhus/globals |
| globals | 14.0.0 | MIT | sindresorhus/globals |
| globals | 17.6.0 | MIT | sindresorhus/globals |
| globalthis | 1.0.4 | MIT | git://github.com/ljharb/System.global |
| gopd | 1.2.0 | MIT | https://github.com/ljharb/gopd |
| got | 11.8.6 | MIT | sindresorhus/got |
| graceful-fs | 4.2.11 | ISC | https://github.com/isaacs/node-graceful-fs |
| graphemer | 1.4.0 | MIT | https://github.com/flmnt/graphemer |
| hachure-fill | 0.5.2 | MIT | https://github.com/pshihn/hachure-fill |
| has-flag | 4.0.0 | MIT | sindresorhus/has-flag |
| has-property-descriptors | 1.0.2 | MIT | https://github.com/inspect-js/has-property-descriptors |
| has-symbols | 1.1.0 | MIT | git://github.com/inspect-js/has-symbols |
| has-tostringtag | 1.0.2 | MIT | https://github.com/inspect-js/has-tostringtag |
| has-unicode | 2.0.1 | ISC | https://github.com/iarna/has-unicode |
| hasown | 2.0.3 | MIT | https://github.com/inspect-js/hasOwn |
| highlight.js | 11.11.1 | BSD-3-Clause | git://github.com/highlightjs/highlight.js |
| hosted-git-info | 4.1.0 | ISC | https://github.com/npm/hosted-git-info |
| html-encoding-sniffer | 4.0.0 | MIT | jsdom/html-encoding-sniffer |
| http-cache-semantics | 4.2.0 | BSD-2-Clause | https://github.com/kornelski/http-cache-semantics |
| http-errors | 1.8.1 | MIT | jshttp/http-errors |
| http-proxy-agent | 5.0.0 | MIT | git://github.com/TooTallNate/node-http-proxy-agent |
| http-proxy-agent | 7.0.2 | MIT | https://github.com/TooTallNate/proxy-agents |
| http2-wrapper | 1.0.3 | MIT | https://github.com/szmarczak/http2-wrapper |
| https-proxy-agent | 5.0.1 | MIT | git://github.com/TooTallNate/node-https-proxy-agent |
| https-proxy-agent | 7.0.6 | MIT | https://github.com/TooTallNate/proxy-agents |
| human-signals | 5.0.0 | Apache-2.0 | ehmicky/human-signals |
| humanize-ms | 1.2.1 | MIT | https://github.com/node-modules/humanize-ms |
| iconv-lite | 0.6.3 | MIT | git://github.com/ashtuchkin/iconv-lite |
| ieee754 | 1.2.1 | BSD-3-Clause | git://github.com/feross/ieee754 |
| ignore | 5.3.2 | MIT | git@github.com:kaelzhang/node-ignore |
| ignore | 7.0.5 | MIT | git@github.com:kaelzhang/node-ignore |
| import-fresh | 3.3.1 | MIT | sindresorhus/import-fresh |
| import-meta-resolve | 4.2.0 | MIT | wooorm/import-meta-resolve |
| imurmurhash | 0.1.4 | MIT | https://github.com/jensyt/imurmurhash-js |
| indent-string | 4.0.0 | MIT | sindresorhus/indent-string |
| infer-owner | 1.0.4 | ISC | https://github.com/npm/infer-owner |
| inflight | 1.0.6 | ISC | https://github.com/npm/inflight |
| inherits | 2.0.4 | ISC | git://github.com/isaacs/inherits |
| internmap | 1.0.1 | ISC | https://github.com/mbostock/internmap |
| internmap | 2.0.3 | ISC | https://github.com/mbostock/internmap |
| ip-address | 10.2.0 | MIT | git://github.com/beaugunderson/ip-address |
| is-arrayish | 0.2.1 | MIT | https://github.com/qix-/node-is-arrayish |
| is-ci | 3.0.1 | MIT | https://github.com/watson/is-ci |
| is-extglob | 2.1.1 | MIT | jonschlinkert/is-extglob |
| is-fullwidth-code-point | 3.0.0 | MIT | sindresorhus/is-fullwidth-code-point |
| is-glob | 4.0.3 | MIT | micromatch/is-glob |
| is-interactive | 1.0.0 | MIT | sindresorhus/is-interactive |
| is-lambda | 1.0.1 | MIT | https://github.com/watson/is-lambda |
| is-path-inside | 3.0.3 | MIT | sindresorhus/is-path-inside |
| is-potential-custom-element-name | 1.0.1 | MIT | https://github.com/mathiasbynens/is-potential-custom-element-name |
| is-stream | 3.0.0 | MIT | sindresorhus/is-stream |
| is-unicode-supported | 0.1.0 | MIT | sindresorhus/is-unicode-supported |
| isarray | 1.0.0 | MIT | git://github.com/juliangruber/isarray |
| isbinaryfile | 4.0.10 | MIT | https://github.com/gjtorikian/isBinaryFile |
| isbinaryfile | 5.0.7 | MIT | https://github.com/gjtorikian/isBinaryFile |
| isexe | 2.0.0 | ISC | https://github.com/isaacs/isexe |
| jackspeak | 3.4.3 | BlueOak-1.0.0 | https://github.com/isaacs/jackspeak |
| jake | 10.9.4 | Apache-2.0 | git://github.com/jakejs/jake |
| js-tokens | 4.0.0 | MIT | lydell/js-tokens |
| js-tokens | 9.0.1 | MIT | lydell/js-tokens |
| js-yaml | 4.1.1 | MIT | nodeca/js-yaml |
| jsdom | 24.1.3 | MIT | https://github.com/jsdom/jsdom |
| jsesc | 3.1.0 | MIT | https://github.com/mathiasbynens/jsesc |
| json-buffer | 3.0.1 | MIT | git://github.com/dominictarr/json-buffer |
| json-parse-even-better-errors | 2.3.1 | MIT | https://github.com/npm/json-parse-even-better-errors |
| json-schema-traverse | 0.4.1 | MIT | https://github.com/epoberezkin/json-schema-traverse |
| json-stable-stringify-without-jsonify | 1.0.1 | MIT | git://github.com/samn/json-stable-stringify |
| json-stringify-safe | 5.0.1 | ISC | git://github.com/isaacs/json-stringify-safe |
| json5 | 2.2.3 | MIT | https://github.com/json5/json5 |
| jsonfile | 4.0.0 | MIT | git@github.com:jprichardson/node-jsonfile |
| jsonfile | 6.2.1 | MIT | git@github.com:jprichardson/node-jsonfile |
| katex | 0.16.47 | MIT | https://github.com/KaTeX/KaTeX |
| keyv | 4.5.4 | MIT | https://github.com/jaredwray/keyv |
| khroma | 2.1.0 | UNKNOWN | github:fabiospampinato/khroma |
| layout-base | 1.0.2 | MIT | https://github.com/iVis-at-Bilkent/layout-base |
| layout-base | 2.0.1 | MIT | https://github.com/iVis-at-Bilkent/layout-base |
| lazy-val | 1.0.5 | MIT | develar/lazy-val |
| lazystream | 1.0.1 | MIT | https://github.com/jpommerening/node-lazystream |
| levn | 0.4.1 | MIT | git://github.com/gkz/levn |
| lines-and-columns | 1.2.4 | MIT | https://github.com/eventualbuddha/lines-and-columns |
| linkify-it | 5.0.0 | MIT | markdown-it/linkify-it |
| linkifyjs | 4.3.3 | MIT | https://github.com/nfrasser/linkifyjs |
| local-pkg | 0.5.1 | MIT | https://github.com/antfu/local-pkg |
| locate-path | 6.0.0 | MIT | sindresorhus/locate-path |
| lodash | 4.18.1 | MIT | lodash/lodash |
| lodash-es | 4.18.1 | MIT | lodash/lodash |
| lodash.defaults | 4.2.0 | MIT | lodash/lodash |
| lodash.difference | 4.5.0 | MIT | lodash/lodash |
| lodash.escaperegexp | 4.1.2 | MIT | lodash/lodash |
| lodash.flatten | 4.4.0 | MIT | lodash/lodash |
| lodash.isequal | 4.5.0 | MIT | lodash/lodash |
| lodash.isplainobject | 4.0.6 | MIT | lodash/lodash |
| lodash.kebabcase | 4.1.1 | MIT | lodash/lodash |
| lodash.merge | 4.6.2 | MIT | lodash/lodash |
| lodash.union | 4.6.0 | MIT | lodash/lodash |
| log-symbols | 4.1.0 | MIT | sindresorhus/log-symbols |
| loose-envify | 1.4.0 | MIT | git://github.com/zertosh/loose-envify |
| loupe | 2.3.7 | MIT | https://github.com/chaijs/loupe |
| lowercase-keys | 2.0.0 | MIT | sindresorhus/lowercase-keys |
| lowlight | 3.3.0 | MIT | wooorm/lowlight |
| lru-cache | 10.4.3 | ISC | git://github.com/isaacs/node-lru-cache |
| lru-cache | 5.1.1 | ISC | git://github.com/isaacs/node-lru-cache.git |
| lru-cache | 6.0.0 | ISC | git://github.com/isaacs/node-lru-cache.git |
| lru-cache | 7.18.3 | ISC | git://github.com/isaacs/node-lru-cache.git |
| lucide-react | 1.16.0 | ISC | https://github.com/lucide-icons/lucide |
| lz-string | 1.5.0 | MIT | https://github.com/pieroxy/lz-string |
| magic-string | 0.30.21 | MIT | https://github.com/Rich-Harris/magic-string |
| make-fetch-happen | 10.2.1 | ISC | https://github.com/npm/make-fetch-happen |
| markdown-it | 14.1.1 | MIT | markdown-it/markdown-it |
| markdown-it-front-matter | 0.2.4 | MIT | git://github.com/ParkSB/markdown-it-front-matter |
| marked | 16.4.2 | MIT | git://github.com/markedjs/marked |
| matcher | 3.0.0 | MIT | sindresorhus/matcher |
| math-intrinsics | 1.1.0 | MIT | https://github.com/es-shims/math-intrinsics |
| mathjax-full | 3.2.2 | Apache-2.0 | https://github.com/mathjax/Mathjax-src/ |
| mdurl | 2.0.0 | MIT | markdown-it/mdurl |
| merge-stream | 2.0.0 | MIT | grncdr/merge-stream |
| mermaid | 11.15.0 | MIT | https://github.com/mermaid-js/mermaid |
| mhchemparser | 4.2.1 | Apache-2.0 | github:mhchem/mhchemParser |
| mime | 2.6.0 | MIT | https://github.com/broofa/mime |
| mime-db | 1.52.0 | MIT | jshttp/mime-db |
| mime-types | 2.1.35 | MIT | jshttp/mime-types |
| mimic-fn | 2.1.0 | MIT | sindresorhus/mimic-fn |
| mimic-fn | 4.0.0 | MIT | sindresorhus/mimic-fn |
| mimic-response | 1.0.1 | MIT | sindresorhus/mimic-response |
| mimic-response | 3.1.0 | MIT | sindresorhus/mimic-response |
| min-indent | 1.0.1 | MIT | https://github.com/thejameskyle/min-indent |
| minimatch | 10.2.5 | BlueOak-1.0.0 | git@github.com:isaacs/minimatch |
| minimatch | 3.1.5 | ISC | git://github.com/isaacs/minimatch |
| minimatch | 5.1.9 | ISC | git://github.com/isaacs/minimatch |
| minimatch | 9.0.9 | ISC | git://github.com/isaacs/minimatch |
| minimist | 1.2.8 | MIT | git://github.com/minimistjs/minimist |
| minipass | 3.3.6 | ISC | https://github.com/isaacs/minipass |
| minipass | 5.0.0 | ISC | https://github.com/isaacs/minipass |
| minipass | 7.1.3 | BlueOak-1.0.0 | https://github.com/isaacs/minipass |
| minipass-collect | 1.0.2 | ISC |  |
| minipass-fetch | 2.1.2 | MIT | https://github.com/npm/minipass-fetch |
| minipass-flush | 1.0.7 | BlueOak-1.0.0 | https://github.com/isaacs/minipass-flush |
| minipass-pipeline | 1.2.4 | ISC |  |
| minipass-sized | 1.0.3 | ISC | https://github.com/isaacs/minipass-sized |
| minizlib | 2.1.2 | MIT | https://github.com/isaacs/minizlib |
| minizlib | 3.1.0 | MIT | https://github.com/isaacs/minizlib |
| mitt | 3.0.1 | MIT | developit/mitt |
| mj-context-menu | 0.6.1 | Apache-2.0 | https://github.com/zorkow/context-menu |
| mkdirp | 1.0.4 | MIT | https://github.com/isaacs/node-mkdirp |
| mlly | 1.8.2 | MIT | unjs/mlly |
| ms | 2.0.0 | MIT | zeit/ms |
| ms | 2.1.3 | MIT | vercel/ms |
| nanoid | 3.3.12 | MIT | ai/nanoid |
| natural-compare | 1.4.0 | MIT | git://github.com/litejs/natural-compare-lite.git |
| negotiator | 0.6.3 | MIT | jshttp/negotiator |
| netmask | 2.1.1 | MIT | git://github.com/rs/node-netmask |
| node-abi | 3.92.0 | MIT | https://github.com/electron/node-abi |
| node-api-version | 0.2.1 | MIT | https://github.com/timfish/node-api-version |
| node-gyp | 9.4.1 | MIT | git://github.com/nodejs/node-gyp |
| node-releases | 2.0.44 | MIT | https://github.com/chicoxyzzy/node-releases |
| nopt | 6.0.0 | ISC | https://github.com/npm/nopt |
| normalize-path | 3.0.0 | MIT | jonschlinkert/normalize-path |
| normalize-url | 6.1.0 | MIT | sindresorhus/normalize-url |
| npm-run-path | 5.3.0 | MIT | sindresorhus/npm-run-path |
| npmlog | 6.0.2 | ISC | https://github.com/npm/npmlog |
| nwsapi | 2.2.23 | MIT | git://github.com/dperini/nwsapi |
| object-keys | 1.1.1 | MIT | git://github.com/ljharb/object-keys |
| once | 1.4.0 | ISC | git://github.com/isaacs/once |
| onetime | 5.1.2 | MIT | sindresorhus/onetime |
| onetime | 6.0.0 | MIT | sindresorhus/onetime |
| optionator | 0.9.4 | MIT | git://github.com/gkz/optionator |
| ora | 5.4.1 | MIT | sindresorhus/ora |
| orderedmap | 2.1.1 | MIT | https://github.com/marijnh/orderedmap |
| p-cancelable | 2.1.1 | MIT | sindresorhus/p-cancelable |
| p-limit | 3.1.0 | MIT | sindresorhus/p-limit |
| p-limit | 5.0.0 | MIT | sindresorhus/p-limit |
| p-locate | 5.0.0 | MIT | sindresorhus/p-locate |
| p-map | 4.0.0 | MIT | sindresorhus/p-map |
| pac-proxy-agent | 7.2.0 | MIT | https://github.com/TooTallNate/proxy-agents |
| pac-resolver | 7.0.1 | MIT | https://github.com/TooTallNate/proxy-agents |
| package-json-from-dist | 1.0.1 | BlueOak-1.0.0 | https://github.com/isaacs/package-json-from-dist |
| package-manager-detector | 1.6.0 | MIT | https://github.com/antfu-collective/package-manager-detector |
| parent-module | 1.0.1 | MIT | sindresorhus/parent-module |
| parse-json | 5.2.0 | MIT | sindresorhus/parse-json |
| parse5 | 7.3.0 | MIT | git://github.com/inikulin/parse5 |
| parseurl | 1.3.3 | MIT | pillarjs/parseurl |
| path-data-parser | 0.1.0 | MIT | https://github.com/pshihn/path-data-parser |
| path-exists | 4.0.0 | MIT | sindresorhus/path-exists |
| path-is-absolute | 1.0.1 | MIT | sindresorhus/path-is-absolute |
| path-key | 3.1.1 | MIT | sindresorhus/path-key |
| path-key | 4.0.0 | MIT | sindresorhus/path-key |
| path-scurry | 1.11.1 | BlueOak-1.0.0 | https://github.com/isaacs/path-scurry |
| pathe | 1.1.2 | MIT | unjs/pathe |
| pathe | 2.0.3 | MIT | unjs/pathe |
| pathval | 1.1.1 | MIT | ssh://git@github.com/chaijs/pathval |
| pe-library | 0.4.1 | MIT | https://github.com/jet2jet/pe-library-js |
| pend | 1.2.0 | MIT | git://github.com/andrewrk/node-pend |
| picocolors | 1.1.1 | ISC | alexeyraspopov/picocolors |
| picomatch | 4.0.4 | MIT | micromatch/picomatch |
| pkg-types | 1.3.1 | MIT | unjs/pkg-types |
| plist | 3.1.1 | MIT | git://github.com/TooTallNate/node-plist |
| points-on-curve | 0.2.0 | MIT | https://github.com/pshihn/bezier-points |
| points-on-path | 0.2.1 | MIT | https://github.com/pshihn/points-on-path |
| postcss | 8.5.14 | MIT | postcss/postcss |
| postcss-nesting | 13.0.2 | MIT-0 | https://github.com/csstools/postcss-plugins |
| postcss-selector-parser | 7.1.1 | MIT | postcss/postcss-selector-parser |
| prelude-ls | 1.2.1 | MIT | git://github.com/gkz/prelude-ls |
| prettier | 3.8.3 | MIT | prettier/prettier |
| pretty-format | 27.5.1 | MIT | https://github.com/facebook/jest |
| pretty-format | 29.7.0 | MIT | https://github.com/jestjs/jest |
| process-nextick-args | 2.0.1 | MIT | https://github.com/calvinmetcalf/process-nextick-args |
| progress | 2.0.3 | MIT | git://github.com/visionmedia/node-progress |
| promise-inflight | 1.0.1 | ISC | https://github.com/iarna/promise-inflight |
| promise-retry | 2.0.1 | MIT | git://github.com/IndigoUnited/node-promise-retry |
| prosemirror-changeset | 2.4.1 | MIT | https://code.haverbeke.berlin/prosemirror/prosemirror-changeset |
| prosemirror-commands | 1.7.1 | MIT | git://github.com/prosemirror/prosemirror-commands |
| prosemirror-dropcursor | 1.8.2 | MIT | git://github.com/prosemirror/prosemirror-dropcursor |
| prosemirror-gapcursor | 1.4.1 | MIT | git://github.com/prosemirror/prosemirror-gapcursor |
| prosemirror-history | 1.5.0 | MIT | git://github.com/prosemirror/prosemirror-history |
| prosemirror-keymap | 1.2.3 | MIT | git://github.com/prosemirror/prosemirror-keymap |
| prosemirror-model | 1.25.7 | MIT | https://code.haverbeke.berlin/prosemirror/prosemirror-model |
| prosemirror-schema-list | 1.5.1 | MIT | git://github.com/prosemirror/prosemirror-schema-list |
| prosemirror-state | 1.4.4 | MIT | git://github.com/prosemirror/prosemirror-state |
| prosemirror-tables | 1.8.5 | MIT | https://github.com/ProseMirror/prosemirror-tables |
| prosemirror-transform | 1.12.0 | MIT | git://github.com/prosemirror/prosemirror-transform |
| prosemirror-view | 1.41.8 | MIT | https://code.haverbeke.berlin/prosemirror/prosemirror-view |
| proxy-agent | 6.5.0 | MIT | https://github.com/TooTallNate/proxy-agents |
| proxy-from-env | 1.1.0 | MIT | https://github.com/Rob--W/proxy-from-env |
| psl | 1.15.0 | MIT | git@github.com:lupomontero/psl |
| pump | 3.0.4 | MIT | git://github.com/mafintosh/pump.git |
| punycode | 2.3.1 | MIT | https://github.com/mathiasbynens/punycode.js |
| punycode.js | 2.3.1 | MIT | https://github.com/mathiasbynens/punycode.js |
| puppeteer-core | 24.43.1 | Apache-2.0 | https://github.com/puppeteer/puppeteer/tree/main/packages/puppeteer-core |
| querystringify | 2.2.0 | MIT | https://github.com/unshiftio/querystringify |
| queue-microtask | 1.2.3 | MIT | git://github.com/feross/queue-microtask |
| quick-lru | 5.1.1 | MIT | sindresorhus/quick-lru |
| react | 18.3.1 | MIT | https://github.com/facebook/react |
| react-dom | 18.3.1 | MIT | https://github.com/facebook/react |
| react-is | 17.0.2 | MIT | https://github.com/facebook/react |
| react-is | 18.3.1 | MIT | https://github.com/facebook/react |
| react-refresh | 0.17.0 | MIT | https://github.com/facebook/react |
| react-router | 6.30.3 | MIT | https://github.com/remix-run/react-router |
| react-router-dom | 6.30.3 | MIT | https://github.com/remix-run/react-router |
| read-binary-file-arch | 1.0.6 | MIT | ssh://git@github.com/samuelmaddock/read-binary-file-arch |
| readable-stream | 2.3.8 | MIT | git://github.com/nodejs/readable-stream |
| readable-stream | 3.6.2 | MIT | git://github.com/nodejs/readable-stream |
| readdir-glob | 1.1.3 | Apache-2.0 | git://github.com/Yqnn/node-readdir-glob |
| readdirp | 4.1.2 | MIT | git://github.com/paulmillr/readdirp |
| redent | 3.0.0 | MIT | sindresorhus/redent |
| require-directory | 2.1.1 | MIT | git://github.com/troygoode/node-require-directory |
| requires-port | 1.0.0 | MIT | https://github.com/unshiftio/requires-port |
| resedit | 1.7.2 | MIT | https://github.com/jet2jet/resedit-js |
| resolve-alpn | 1.2.1 | MIT | https://github.com/szmarczak/resolve-alpn |
| resolve-from | 4.0.0 | MIT | sindresorhus/resolve-from |
| responselike | 2.0.1 | MIT | https://github.com/sindresorhus/responselike |
| restore-cursor | 3.1.0 | MIT | sindresorhus/restore-cursor |
| retry | 0.12.0 | MIT | git://github.com/tim-kos/node-retry |
| reusify | 1.1.0 | MIT | https://github.com/mcollina/reusify |
| rimraf | 3.0.2 | ISC | git://github.com/isaacs/rimraf.git |
| roarr | 2.15.4 | BSD-3-Clause | git@github.com:gajus/roarr |
| robust-predicates | 3.0.3 | Unlicense | https://github.com/mourner/robust-predicates |
| rollup | 4.60.4 | MIT | https://github.com/rollup/rollup |
| rope-sequence | 1.3.4 | MIT | https://github.com/marijnh/rope-sequence |
| roughjs | 4.6.6 | MIT | https://github.com/pshihn/rough |
| rrweb-cssom | 0.7.1 | MIT | rrweb-io/CSSOM |
| rrweb-cssom | 0.8.0 | MIT | rrweb-io/CSSOM |
| run-parallel | 1.2.0 | MIT | git://github.com/feross/run-parallel |
| rw | 1.3.3 | BSD-3-Clause | http://github.com/mbostock/rw |
| safe-buffer | 5.1.2 | MIT | git://github.com/feross/safe-buffer |
| safe-buffer | 5.2.1 | MIT | git://github.com/feross/safe-buffer |
| safer-buffer | 2.1.2 | MIT | https://github.com/ChALkeR/safer-buffer |
| sanitize-filename | 1.6.4 | WTFPL OR ISC | git@github.com:parshap/node-sanitize-filename |
| sax | 1.6.0 | BlueOak-1.0.0 | ssh://git@github.com/isaacs/sax-js |
| saxes | 6.0.0 | ISC | https://github.com/lddubeau/saxes.git |
| scheduler | 0.23.2 | MIT | https://github.com/facebook/react |
| semver | 6.3.1 | ISC | https://github.com/npm/node-semver |
| semver | 7.7.4 | ISC | https://github.com/npm/node-semver |
| semver | 7.8.0 | ISC | https://github.com/npm/node-semver |
| semver-compare | 1.0.0 | MIT | git://github.com/substack/semver-compare |
| serialize-error | 7.0.1 | MIT | sindresorhus/serialize-error |
| serve-index | 1.9.2 | MIT | expressjs/serve-index |
| set-blocking | 2.0.0 | ISC | https://github.com/yargs/set-blocking |
| setprototypeof | 1.2.0 | ISC | https://github.com/wesleytodd/setprototypeof |
| shebang-command | 2.0.0 | MIT | kevva/shebang-command |
| shebang-regex | 3.0.0 | MIT | sindresorhus/shebang-regex |
| siginfo | 2.0.0 | ISC | https://github.com/emilbayes/siginfo |
| signal-exit | 3.0.7 | ISC | https://github.com/tapjs/signal-exit |
| signal-exit | 4.1.0 | ISC | https://github.com/tapjs/signal-exit |
| simple-update-notifier | 2.0.0 | MIT | https://github.com/alexbrazier/simple-update-notifier |
| smart-buffer | 4.2.0 | MIT | https://github.com/JoshGlazebrook/smart-buffer |
| socks | 2.8.9 | MIT | https://github.com/JoshGlazebrook/socks |
| socks-proxy-agent | 7.0.0 | MIT | git://github.com/TooTallNate/node-socks-proxy-agent |
| socks-proxy-agent | 8.0.5 | MIT | https://github.com/TooTallNate/proxy-agents |
| source-map | 0.6.1 | BSD-3-Clause | http://github.com/mozilla/source-map |
| source-map-js | 1.2.1 | BSD-3-Clause | 7rulnik/source-map-js |
| source-map-support | 0.5.21 | MIT | https://github.com/evanw/node-source-map-support |
| speech-rule-engine | 4.1.4 | Apache-2.0 | https://github.com/zorkow/speech-rule-engine |
| sprintf-js | 1.1.3 | BSD-3-Clause | https://github.com/alexei/sprintf.js |
| ssri | 9.0.1 | ISC | https://github.com/npm/ssri |
| stackback | 0.0.2 | MIT | git://github.com/shtylman/node-stackback |
| stat-mode | 1.0.0 | MIT | git://github.com/TooTallNate/stat-mode |
| statuses | 1.5.0 | MIT | jshttp/statuses |
| std-env | 3.10.0 | MIT | unjs/std-env |
| streamx | 2.25.0 | MIT | https://github.com/mafintosh/streamx |
| string_decoder | 1.1.1 | MIT | git://github.com/nodejs/string_decoder |
| string_decoder | 1.3.0 | MIT | git://github.com/nodejs/string_decoder |
| string-width | 4.2.3 | MIT | sindresorhus/string-width |
| string-width | 5.1.2 | MIT | sindresorhus/string-width |
| strip-ansi | 6.0.1 | MIT | chalk/strip-ansi |
| strip-ansi | 7.2.0 | MIT | chalk/strip-ansi |
| strip-final-newline | 3.0.0 | MIT | sindresorhus/strip-final-newline |
| strip-indent | 3.0.0 | MIT | sindresorhus/strip-indent |
| strip-json-comments | 3.1.1 | MIT | sindresorhus/strip-json-comments |
| strip-literal | 2.1.1 | MIT | https://github.com/antfu/strip-literal |
| stylis | 4.4.0 | MIT | https://github.com/thysultan/stylis.js |
| sumchecker | 3.0.1 | Apache-2.0 | https://github.com/malept/sumchecker |
| supports-color | 7.2.0 | MIT | chalk/supports-color |
| symbol-tree | 3.2.4 | MIT | https://github.com/jsdom/js-symbol-tree |
| tar | 6.2.1 | ISC | https://github.com/isaacs/node-tar |
| tar | 7.5.15 | BlueOak-1.0.0 | https://github.com/isaacs/node-tar |
| tar-fs | 3.1.2 | MIT | https://github.com/mafintosh/tar-fs |
| tar-stream | 2.2.0 | MIT | https://github.com/mafintosh/tar-stream |
| tar-stream | 3.2.0 | MIT | https://github.com/mafintosh/tar-stream |
| teex | 1.0.1 | MIT | https://github.com/mafintosh/teex |
| temp-file | 3.4.0 | MIT | develar/temp-file |
| text-decoder | 1.2.7 | Apache-2.0 | https://github.com/holepunchto/text-decoder |
| text-table | 0.2.0 | MIT | git://github.com/substack/text-table |
| tiny-typed-emitter | 2.1.0 | MIT | https://github.com/binier/tiny-typed-emitter.git |
| tinybench | 2.9.0 | MIT | tinylibs/tinybench |
| tinyexec | 1.1.2 | MIT | https://github.com/tinylibs/tinyexec |
| tinyglobby | 0.2.16 | MIT | https://github.com/SuperchupuDev/tinyglobby |
| tinypool | 0.8.4 | MIT | https://github.com/tinylibs/tinypool |
| tinyspy | 2.2.1 | MIT | https://github.com/tinylibs/tinyspy |
| tmp | 0.2.5 | MIT | https://github.com/raszi/node-tmp.git |
| tmp-promise | 3.0.3 | MIT | git://github.com/benjamingr/tmp-promise |
| toidentifier | 1.0.1 | MIT | component/toidentifier |
| tough-cookie | 4.1.4 | BSD-3-Clause | git://github.com/salesforce/tough-cookie |
| tr46 | 5.1.1 | MIT | https://github.com/jsdom/tr46 |
| truncate-utf8-bytes | 1.0.2 | WTFPL | https://github.com/parshap/truncate-utf8-bytes |
| ts-api-utils | 2.5.0 | MIT | https://github.com/JoshuaKGoldberg/ts-api-utils |
| ts-dedent | 2.2.0 | MIT | https://github.com/tamino-martinius/node-ts-dedent |
| tslib | 2.8.1 | 0BSD | https://github.com/Microsoft/tslib |
| type-check | 0.4.0 | MIT | git://github.com/gkz/type-check |
| type-detect | 4.1.0 | MIT | ssh://git@github.com/chaijs/type-detect |
| type-fest | 0.13.1 | (MIT OR CC0-1.0) | sindresorhus/type-fest |
| type-fest | 0.20.2 | (MIT OR CC0-1.0) | sindresorhus/type-fest |
| typed-query-selector | 2.12.2 | MIT | g-plane/typed-query-selector |
| typescript | 5.9.3 | Apache-2.0 | https://github.com/microsoft/TypeScript |
| typescript-eslint | 8.60.0 | MIT | https://github.com/typescript-eslint/typescript-eslint |
| uc.micro | 2.1.0 | MIT | markdown-it/uc.micro |
| ufo | 1.6.4 | MIT | unjs/ufo |
| undici-types | 6.21.0 | MIT | https://github.com/nodejs/undici |
| unique-filename | 2.0.1 | ISC | https://github.com/npm/unique-filename |
| unique-slug | 3.0.0 | ISC | https://github.com/npm/unique-slug |
| universalify | 0.1.2 | MIT | https://github.com/RyanZim/universalify |
| universalify | 0.2.0 | MIT | https://github.com/RyanZim/universalify |
| universalify | 2.0.1 | MIT | https://github.com/RyanZim/universalify |
| update-browserslist-db | 1.2.3 | MIT | browserslist/update-db |
| uri-js | 4.4.1 | BSD-2-Clause | http://github.com/garycourt/uri-js |
| url-parse | 1.5.10 | MIT | https://github.com/unshiftio/url-parse |
| use-sync-external-store | 1.6.0 | MIT | https://github.com/facebook/react |
| utf8-byte-length | 1.0.5 | (WTFPL OR MIT) | https://github.com/parshap/utf8-byte-length |
| util-deprecate | 1.0.2 | MIT | git://github.com/TooTallNate/util-deprecate |
| uuid | 14.0.0 | MIT | https://github.com/uuidjs/uuid |
| vite | 5.4.21 | MIT | https://github.com/vitejs/vite |
| vite-node | 1.6.1 | MIT | https://github.com/vitest-dev/vitest |
| vitest | 1.6.1 | MIT | https://github.com/vitest-dev/vitest |
| w3c-keyname | 2.2.8 | MIT | https://github.com/marijnh/w3c-keyname |
| w3c-xmlserializer | 5.0.0 | MIT | jsdom/w3c-xmlserializer |
| wcwidth | 1.0.1 | MIT | https://github.com/timoxley/wcwidth |
| webdriver-bidi-protocol | 0.4.1 | Apache-2.0 | https://github.com/GoogleChromeLabs/webdriver-bidi-protocol |
| webidl-conversions | 7.0.0 | BSD-2-Clause | jsdom/webidl-conversions |
| whatwg-encoding | 3.1.1 | MIT | jsdom/whatwg-encoding |
| whatwg-mimetype | 4.0.0 | MIT | jsdom/whatwg-mimetype |
| whatwg-url | 14.2.0 | MIT | jsdom/whatwg-url |
| which | 2.0.2 | ISC | git://github.com/isaacs/node-which |
| why-is-node-running | 2.3.0 | MIT | https://github.com/mafintosh/why-is-node-running |
| wicked-good-xpath | 1.3.0 | MIT | https://github.com/google/wicked-good-xpath |
| wide-align | 1.1.5 | ISC | https://github.com/iarna/wide-align |
| word-wrap | 1.2.5 | MIT | jonschlinkert/word-wrap |
| wrap-ansi | 7.0.0 | MIT | chalk/wrap-ansi |
| wrap-ansi | 8.1.0 | MIT | chalk/wrap-ansi |
| wrappy | 1.0.2 | ISC | https://github.com/npm/wrappy |
| ws | 8.20.1 | MIT | https://github.com/websockets/ws |
| xml-name-validator | 5.0.0 | Apache-2.0 | jsdom/xml-name-validator |
| xmlbuilder | 15.1.1 | MIT | git://github.com/oozcitak/xmlbuilder-js |
| xmlchars | 2.2.0 | MIT | https://github.com/lddubeau/xmlchars.git |
| xss | 1.0.15 | MIT | git://github.com/leizongmin/js-xss |
| y18n | 5.0.8 | ISC | yargs/y18n |
| yallist | 3.1.1 | ISC | https://github.com/isaacs/yallist |
| yallist | 4.0.0 | ISC | https://github.com/isaacs/yallist |
| yallist | 5.0.0 | BlueOak-1.0.0 | https://github.com/isaacs/yallist |
| yargs | 17.7.2 | MIT | https://github.com/yargs/yargs |
| yargs-parser | 21.1.1 | ISC | https://github.com/yargs/yargs-parser |
| yauzl | 2.10.0 | MIT | https://github.com/thejoshwolfe/yauzl |
| yocto-queue | 0.1.0 | MIT | sindresorhus/yocto-queue |
| yocto-queue | 1.2.2 | MIT | sindresorhus/yocto-queue |
| zip-stream | 4.1.1 | MIT | https://github.com/archiverjs/node-zip-stream |
| zod | 3.25.76 | MIT | https://github.com/colinhacks/zod |
| zod | 4.4.3 | MIT | https://github.com/colinhacks/zod |
