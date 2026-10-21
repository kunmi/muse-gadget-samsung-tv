# Building and releasing Muse Gadget TV

## Build the .wgt locally

```sh
bash tools/build-wgt.sh
```

That syntax-checks every script in `app/js/` (when Node is available) and
zips the **contents** of `app/` into `dist/muse-gadget-tv.wgt`, so
`config.xml` sits at the archive root — a `.wgt` is a zip with the Tizen
manifest at its root. Verify with `unzip -l dist/muse-gadget-tv.wgt`.

The package is deliberately **unsigned**: Apps2Samsung (and Tizen Studio's
package manager) apply the Samsung developer certificate at install time.
If you sign for a store or a managed fleet, do it in Tizen Studio against
the `app/` project — the sources need no changes.

There is no other build: the app is static HTML/CSS/JS, no bundler, no
transpiler, no `node_modules` at runtime.

## Tests

```sh
node tests/run-tests.js           # or: npm test
```

Everything runs offline. The interop test (JS client ↔ the SDK's Python
implementation) needs two extras and skips cleanly without them:

- a checkout of `facebookincubator/muse-gadget-sdk` next to this repo (or
  `$MUSE_GADGET_SDK_LINUX_SRC` pointing at its `linux/src`), and
- a Python with the `cryptography` package (`$MUSE_GADGET_PYTHON` selects
  the interpreter).

CI (`.github/workflows/ci.yml`) provides both and runs the full suite.

## TizenBrew module layout

TizenBrew application modules are plain web apps described by a
`package.json` (see TizenBrew's `docs/MODULES.md`). This repo's root
`package.json` is that manifest:

```json
{
  "packageType": "app",
  "appName": "Muse Gadget TV",
  "appPath": "app/index.html",
  "keys": []
}
```

- `packageType: "app"` — an application module (a web page; nothing is
  installed on the TV by TizenBrew itself, the module is served).
- `appPath` — where the app entry point lives inside the module.
- `keys` — remote keys the module asks TizenBrew to register via the
  TVInputDevice API. The app uses only the standard navigation keys
  (arrows, Enter, Back), which need no registration, so the list is empty.
- Because the app is fully static (no server side, no build output), it can
  be hosted from GitHub Pages, the raw GitHub content of a release, or any
  static file server, and added to TizenBrew by URL.

The same `app/` tree serves both distribution paths: zipped it is the
`.wgt`; served as-is it is the TizenBrew module payload.

## Releases

`.github/workflows/release.yml` runs on tags matching `v*`:

1. checks out the repo, runs the Node test suite (interop skips there —
   CI on pushes/PRs runs it in full),
2. builds `dist/muse-gadget-tv.wgt` with `tools/build-wgt.sh`,
3. creates a GitHub Release for the tag and attaches the `.wgt`, so
   Apps2Samsung users and manual sideloaders can download it directly.

To cut a release: bump `version` in `app/config.xml` and `package.json`,
commit, then `git tag vX.Y.Z && git push --tags`.

## Versioning note

The app reports version `0.1.0` in `link.register`. The Muse Gadget SDK's
Linux client is also `0.1.0`-lineage; the number is this project's own and
says nothing about SDK compatibility beyond the protocol documented in
PROTOCOL.md.
