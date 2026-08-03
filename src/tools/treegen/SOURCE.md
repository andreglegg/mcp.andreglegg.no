# Vendored from treegen

`generator.js` and `export.js` are copied verbatim from `~/Apps/treegen/mcp/`
as of 2026-08-03.

**Do not edit them here.** Fix upstream first, then re-copy:

    cp ~/Apps/treegen/mcp/generator.js src/tools/treegen/generator.js
    cp ~/Apps/treegen/mcp/export.js    src/tools/treegen/export.js

`index.js` is *not* vendored — it is the remote-specific tool layer and has no
upstream counterpart. The local server at `~/Apps/treegen/mcp/server.js` writes
files to disk; this one writes to the artifact store instead.
