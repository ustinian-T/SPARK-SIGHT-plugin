# Bundled CJK font

Noto Sans CJK SC Regular, Sans 2.004, unmodified upstream font.
Source: https://github.com/notofonts/noto-cjk/tree/main/Sans/OTF/SimplifiedChinese
License: SIL Open Font License 1.1 (OFL.txt).
SHA-256: `2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b`.

This directory is part of the shared Agent source bundle, including desktop,
VS Code, dsh and server packages. The runner stages these public assets into
each execution directory; strong sandboxes mount them read-only. Python registers
the font directly; Linux R/Cairo uses the included fontconfig configuration.
