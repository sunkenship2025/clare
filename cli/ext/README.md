`scripts/build.mjs` copies the built browser extension (`dist/extension`) here before compiling the CLI, so the
release binary carries it and `clare enroll` can write it to disk for "Load unpacked". Only this file is committed;
a plain `go build` gets no extension and the CLI falls back to the zip on the enroll page.
