# sshdesk plugins

A plugin is a directory containing `manifest.json` and `index.js`. sshdesk
reads the manifest at boot to put the app in the dock; the JavaScript is not
executed until you open a window, and then it runs in its own isolated view
with exactly the access the manifest declares and you approved. No
recompilation of sshdesk is needed.

```
plugins/
  ports/
    manifest.json   # required — identity, window, and the permissions it needs
    index.js        # required — the module the app runtime loads
    style.css       # optional — loaded into the app's own view
    src/index.jsx   # optional — source, if you use a build step
    package.json    # optional — only if you build
```

**Plugin roots** are merged in this order; a later folder with the same name
replaces an earlier one:
1. Plugins shipped inside the app bundle
2. `~/.sshdesk/plugins`
3. `$SSHDESK_PLUGINS` (set to this directory by the development commands)

Use **Settings → Apps & Extensions → Reload extensions** to re-read from disk
without restarting. Settings asks before closing open extension windows, since
their component identity changes. The existing **⌘R** shortcut and desktop menu
also reload plugins.

System, Services (`systemctl`), Ports, and VS Code use this same extension
mechanism. Settings discovers their app details and declared appearance controls
from the manifest; no app-specific Settings page is required. Software installed
on a connected machine, such as VS Code's supporting server, appears separately
under **Remote Tools**.

---

## Develop from any local folder

Open **Settings → Developer**, enable **Developer mode**, and choose **Load
local app…**. Browse to your app folder or paste an absolute path (`~/…` works).
The selected folder must contain `index.js` and optionally `style.css`.
Registrations and their enabled/watch settings are saved on this Mac across
restarts. Nothing is copied into the app bundle and sshdesk does not need to be
rebuilt for plugin edits.

Each app has **Open**, **Reload**, **Reload on changes**, an enable switch, and
**Remove registration**. Removing a registration never deletes source files.
Disabling developer mode unloads local registrations while keeping their paths.
Existing installed/shipped extensions continue to work.

A reload replaces only that app's content, preserving its windows, positions,
sizes, host assignments, and minimized/snapped state. Temporary React state resets.
Save work before reloading. Automatic reload is opt-in; it checks `index.js` and
`style.css` once a second and waits for two matching file observations before
loading. It pauses during desktop drag/resize and modal dialogs.

Load errors appear on the app's card. If a new build fails to import, validate,
or create its component, the previous working definition and CSS remain active.
Render errors are contained by the app window and also appear in Developer
settings; reload after fixing the code to reset the error boundary.

Local app IDs must be unique among enabled local apps. Built-in app IDs are
reserved. Matching a shipped extension's ID temporarily overrides it; disabling
or removing that local app restores the shipped version. To rename an app ID,
remove its registration and add it again.

For JSX/TypeScript, use a bundler in watch mode, for example:

```sh
npx esbuild src/index.jsx --bundle --format=esm --jsx=transform --outfile=index.js --watch
```

Keep `React` injected through `createApp` as described below. Bundle module
dependencies into the entry file. The loader evaluates the bundle from a blob
URL; relative imports, split chunks, and relative image/font URLs do not resolve
to the local project folder. Inline assets or use the platform's icon system.
Put component subscriptions, timers, and event handlers in React effects and
clean them up when unmounted; avoid persistent side effects at module scope.
This is content reload, not React Fast Refresh.

Use **Settings → Developer → Open DevTools** to inspect the desktop and local
apps, including in the compiled release app. On macOS this opens WebKit's Web
Inspector, with Elements, Console, Sources, and Network tools. Local apps share
the desktop inspector. Bundles include `sshdesk-plugin://` source annotations
matching their folders, although WebKit can still list imported modules as
`blob:` scripts. Search Sources for your app name or manifest ID to find its
code. Embedded web apps such as VS Code have a separate webview and are not
inspected by this button.

Start with the working [Hello Local example](../examples/hello-app).
Developer registrations live in `developer-apps.json` in Tauri's app configuration
directory on this Mac, separately from per-machine appearance settings.

---

## `manifest.json` — identity and permissions

The manifest is data, read without running your code. Everything sshdesk
needs before a window opens lives here:

```json
{
  "schemaVersion": 1,
  "id": "ports",                     // unique; also the app id and token namespace
  "name": "Ports",                   // dock label and window title
  "description": "Inspect listening ports and open SSH tunnels.",
  "version": "1.0.0",                // required; shown in the consent screen
  "author": "Your name",             // optional, shown in app details
  "icon": "lucide:ethernet-port",    // a pack icon, or an emoji — both work
  "window": { "w": 940, "h": 520 },  // optional initial size
  "permissions": ["remote.exec", "remote.sudo", "remote.tunnels", "desktop.openUrl"],
  "requires": [ ... ],               // remote dependencies, see below
  "tokens": { ... }                  // appearance tokens, see below
}
```

`id` is lowercase (`[a-z][a-z0-9_-]*`) and cannot be a built-in app's. An
unknown permission, a duplicate, or a token default that is not a plain
colour/length/icon value rejects the whole manifest, and Settings says why.
`requires` needs `remote.exec`, since installed software is run through it.

### Permissions

Declare only what your code calls. Each one is a sentence on the consent
screen, and an operation without its permission is refused by the native
gateway with `PermissionDenied`, never silently.

| Permission | Unlocks | Grants the app |
|---|---|---|
| `remote.files.read` | `fs.list / read / readBinary / disk / caps` | Read files your SSH account can |
| `remote.files.write` | `fs.write / mkdir / rename / copy / remove`, `fs:changed` events | Change those files |
| `remote.exec` | `sdk.exec`, `sdk.capability` | Run commands as your SSH user |
| `remote.sudo` | `sdk.sudo`, password prompts | Ask for your administrator password |
| `remote.dbus` | `dbus.call / get / systemd`, `sys.watchUnits` | Talk to system services |
| `remote.system` | `sys.snapshot`, `sys.clock` | Read processes, services, ports, time |
| `remote.tunnels` | `net.forward / forwardSocket / unforward / forwards` | Expose remote services on local ports |
| `desktop.openUrl` | `net.openUrl`, `ui.open` | Open its tunnels in a browser, open other apps |
| `desktop.embed` | `EmbeddedWebview` | Show one of its tunnels inside its window |
| `network` | `fetch`, `WebSocket` | Reach the internet directly from the app view |

`sudo` is separate from `exec` on purpose: an app that only lists things
should not be able to ask for the root password. Tunnels an app opens are its
own — `openUrl` and `EmbeddedWebview` accept only ports it forwarded, and they
are closed with the window.

`ui.confirm / prompt / alert`, `prefs`, `bus`, `host.current`, `path` and
`fmt` need no permission. The rest of the desktop framework — connecting
machines, terminals, packages, dependency installs, configuration, local
downloads and drags — is not available to apps at all; those stay desktop
actions the user takes.

### Consent

The first time you open an app on a machine, sshdesk shows its name, version,
source folder and each requested permission, and asks before any of its code
runs. Approval is saved per app, per machine, in `app-grants.json` in the app
configuration directory on this Mac. An app with an empty `permissions` list
opens without a prompt. Settings → Apps & Extensions → *app* → **Revoke
access…** forgets the approval and closes its windows.

A published app's approval is pinned to the exact bytes of its manifest, code
and stylesheet, so an update asks again. A local app registered in Developer
settings is approved for its folder: code edits reuse the approval, and only a
change to `manifest.json` asks again.

### Remote dependencies

```js
  // What this plugin needs on the remote. Checked when a window opens; the
  // user is shown what would happen and asked before anything is installed.
  "requires": [
    // probe only — a missing command is reported, never installed
    { kind: 'command', command: 'git', hint: 'install git to use this' },

    // a real package. Names differ per distro, and they have to be declared:
    // PackageKit's apt backend cannot map a *missing* file to a package.
    { kind: 'package', command: 'docker',
      packages: { apt: 'docker.io', dnf: 'docker', default: 'docker' } },

    // not in any repo. Lands in ~/.sshdesk/opt, so it needs no root at all
    // and `rm -rf` undoes it. The checksum is required, not optional.
    { kind: 'archive', command: 'openvscode-server',
      url: 'https://example.com/openvscode-server-${arch}.tar.gz',
      sha256: { aarch64: '…64 hex…', x86_64: '…64 hex…' },
      into: 'openvscode-server', bin: 'bin/openvscode-server' },
  ],

  // Tokens you own. Settings renders an editor for these with no code written
  // for your plugin, and users change them in one place for every app.
  "tokens": {
    "app":       { "type": "icon",  "default": "desk:network", "label": "App icon" },
    "listening": { "type": "icon",  "default": "desk:service", "label": "Listening port" },
    // '@' inherits from another token: retint the desktop and this follows.
    "mine":      { "type": "color", "default": "@desk.ok",     "label": "My port" }
  }
```

## `index.js` — the two exports

```js
export function createAdapter(sdk) { ... }   // JSON -> CLI -> JSON. Optional.
export function createApp(ctx) { ... }       // returns a React component. Required.
```

An `export const manifest` is still allowed for tooling, but sshdesk reads
`manifest.json`; if both exist their `id` must match. Nothing else is loaded.
An app that throws while starting shows the error in its own window and in
Developer settings. The rest of the desktop is unaffected — each app runs in a
separate view, so it cannot take the desktop or another app down.

---

## `createAdapter(sdk)` — the machine boundary

Return an object of async functions. This is the only place that talks to the
remote machine.

### Three tiers, and you should always take the highest one available

Linux desktops do not shell out. They call typed IPC — D-Bus for system
services, the kernel's own interfaces for state. `systemctl` is *itself* a
D-Bus client; `ss` queries netlink. Parsing their output means asking a CLI to
render a typed API into text so you can turn it back into data, and that text
is the part that changes between distro releases.

So the sdk gives you three tiers. The tier tells you what reliability you get.

**Tier 1 — a real protocol exists. No parsing, ever.**

| | |
|---|---|
| `sdk.fs.list(path)` | Directory entries with typed attrs — size, mtime, mode, user, group |
| `sdk.fs.read / write / mkdir / rename / copy / remove` | SFTP. `copy` is server-side where the host supports it |
| `sdk.fs.disk(path)` | `{ total, free, avail }` as numbers |
| `sdk.fs.caps()` | Which SFTP extensions this server offers |
| `sdk.dbus.systemd(member, sig?, args?)` | Call the systemd manager |
| `sdk.dbus.call(dest, path, iface, member, sig?, args?)` | Any bus service |
| `sdk.dbus.get(dest, path, iface, prop)` | One property, typed |

```js
// every unit on the box, typed, no parser, no process spawned on the remote
const [units] = await sdk.dbus.systemd('ListUnits')
const failed = units.filter(u => u[3] === 'failed')
```

`signature` describes argument types exactly as `busctl call` does — `'ss'` is
two strings — because JSON cannot tell a byte from a uint32.

**Tier 2 — no protocol, but a stable kernel ABI.** Process listing and
listening ports have no bus service. `snapshot()` reads `/proc` and `ss` for
you; both are far steadier than `ps` output formatting.

**Tier 3 — the escape hatch.** For docker, nginx, your own daemons: anything
without a schema.

| | |
|---|---|
| `sdk.exec(argv)` | Run on the connected host. Returns `{ stdout, stderr, code, elapsed_ms }` |
| `sdk.sudo(argv)` | Same, escalated. Prompts once per host per session, cached in memory only |
| `sdk.capability(name, probe)` | Run `probe(exec)` once per host and cache the boolean |
| `sdk.host()` | Current `user@host` |

**`argv` is an array, never a string.** Each element is shell-quoted
separately, so a value can never widen into extra arguments or a second
command. Validate anything that came from the machine before passing it back:

```js
const UNIT = /^[A-Za-z0-9@._:-]+$/
if (!UNIT.test(name)) throw new Error(`refusing suspicious unit: ${name}`)
```

### Your app icon

`manifest.icon` takes either a pack id or a glyph:

```js
icon: 'lucide:ethernet-port'   // from the bundled Lucide set, 2000+ icons
icon: 'desk:service'           // from the small curated set
icon: '🔌'                      // still fine
```

A pack icon inherits the desktop's colours and stays sharp at any size; an
emoji does neither, and looks like an emoji sitting in a row of line icons.
Search the sets in Settings — any icon row opens a picker.

Whatever you put here becomes the default for your `<id>.app` token, so a user
can change it in Settings without touching your plugin. That is the whole
mechanism; you do not need to declare the token yourself.

### Tokens: icons and colours

The namespace is your plugin's id, so `ports.mine` is yours and
`files.dir_fg` is the file manager's. The platform uses your app icon in the dock,
window title, and Settings. Color and length declarations become CSS variables
inside your app; use those variables in your own styles.

Settings provides icon, color (including opacity), image file, and length
editors. Use `label` and optional `hint` text to explain each preference. These
are appearance declarations, not a general schema for credentials, switches,
or arbitrary app configuration. Keep additional preferences inside your app.

Configuration is saved in `~/.sshdesk/config.toml` on the Mac. A machine's
override takes precedence over the default your app declares:

```toml
[machine."user@host".icons.ports]
app = "desk:network"

[machine."user@host".theme.ports]
mine = "#4ade80"
```

An icon value is either `pack:name` or a plain glyph, so `"🔌"` stays valid and
you can adopt tokens one at a time rather than converting everything at once.

Colour tokens become CSS variables scoped to your windows — `ports.mine` is
`var(--ports-mine)` inside `.app-ports` — so plain CSS in your `style.css`
picks them up.

### If you are on tier 3, three things worth doing

**Probe capabilities, don't assume.** The same command differs across distros.
(On tier 1 you don't need this — D-Bus is introspectable and `sdk.fs.caps()`
tells you what the file server supports.)

**Prefer machine-readable output** — `-o json`, explicit `--format`. Parsing
human output is what rots across versions.

**A non-zero exit is not always an error.** `systemctl is-active` returns 3 for
"inactive". Map the code; don't throw.

---

## `createApp(ctx)` — the UI

Return a React component. `ctx` provides:

| | |
|---|---|
| `React` | The platform's React — **do not import your own**, hooks would break |
| `html` | `htm` tagged template, for JSX-like markup with no build step |
| `api` | Whatever `createAdapter` returned |
| `fw` | The platform API (see below) |
| `useApi()` | Adapter pinned to this window's machine; prefer it inside components |
| `useFw()` | Platform API pinned to this window's machine; prefer it inside components |
| `EmbeddedWebview` | A React component for an SSH-forwarded web app inside a desktop window |

Your component receives `{ setTitle }` to set its window title.

### Web apps inside the desktop

Use `EmbeddedWebview` for a remote web application after forwarding its socket
with `fw.net.forwardSocket()`. It attaches to the current desktop window;
`fw.openWindow()` creates a separate operating-system window instead.

```js
export function createApp({ html, EmbeddedWebview }) {
  return function App({ url }) {
    return html`<div class="desk-app">
      <${EmbeddedWebview} url=${url} title="My editor" />
    </div>`
  }
}
```

The component accepts `url`, `title`, `onReady()`, and `onError(message)`.
Only HTTP loopback addresses are accepted. Authentication remains the app's
responsibility; VS Code keeps its connection token and first-party browser
storage. Remote content receives no desktop IPC permissions.

The desktop handles view geometry, minimizing, and disposal. Native views
stay alive but hide while their window is inactive or a desktop menu/dialog
is open, so they cannot cover desktop controls. Closing the window disposes
the local view; stopping a remote server remains an explicit app action.

### Two ways to write markup

**No build step** — use `html`:

```js
export function createApp({ React, html, api }) {
  return function App() {
    return html`<div class="my-root">hello</div>`
  }
}
```

**With a build step** — real JSX. Build with the *classic* transform so `<div/>`
compiles to `React.createElement`, which resolves to the injected `React`:

```json
{ "scripts": {
  "build": "esbuild src/index.jsx --bundle --format=esm --jsx=transform --outfile=index.js"
} }
```

Never `import React from 'react'` — the classic transform picks up the `React`
you destructured from `ctx`, and the plugin ships no React of its own.

### `style` takes an object, never a string

`html` builds React elements, so this throws where plain HTML would not:

```js
html`<div style="padding:16px">…</div>`      // React error #62
html`<div style=${{ padding: 16 }}>…</div>`  // fine
html`<div class="my-pad">…</div>`            // better — put it in style.css
```

The error is real and fatal: it unmounts your app. sshdesk catches it per
window rather than letting it take the desktop down, but the window still shows
a stack trace instead of your app.

### Styling: use `style.css`, not Tailwind

Tailwind generates classes by scanning source **at build time**, so a plugin
installed later can never rely on it. Ship a `style.css` and write plain CSS
against the desktop's tokens:

```css
.my-root { background: var(--color-desk-panel); color: var(--color-desk-fg); }
.my-row:hover { background: rgb(255 255 255 / .05); }
```

Available tokens: `--color-desk-bg`, `--color-desk-panel`, `--color-desk-line`,
`--color-desk-fg`, `--color-desk-dim`, `--color-desk-accent`,
`--color-desk-ok`, `--color-desk-bad`.

### Shared desktop controls

Use the desktop's CSS classes for the same controls as the built-in apps. These
are available at runtime, without a Tailwind build:

```js
html`<div class="desk-app">
  <div class="app-toolbar">
    <label class="app-search"><input aria-label="Filter items" placeholder="Filter items" /></label>
    <button class="app-button" onClick=${refresh}>Refresh</button>
  </div>
  <div class="my-scrollable-content">…</div>
  <footer class="app-statusbar">${count} items</footer>
</div>`
```

The shared classes include `app-button` (with `is-primary`, `is-danger`, and
`is-icon` variants), `app-segmented`, `app-check`, `app-notice`,
`app-empty-state`, and `app-inspector`. Supply accessible labels, real disabled
states, and `aria-pressed` for toggles. Keep your content styles scoped to your
own class names. A scrollable content region should use `flex: 1`,
`min-height: 0`, and `overflow: auto`.

### Useful bits of `fw`

```js
fw.fs.list(path) / read / readBinary / write / mkdir / rename / copy / remove / disk / caps
fw.net.forward(remotePort, preferredLocal?) / unforward / forwards / forwardSocket / openUrl
fw.sys.snapshot() / clock() / watchUnits()
fw.ui.confirm(o) / prompt(o) / alert(o) / open(appId, props)
fw.prefs.get(key, fallback) / set(key, value)      // this app's own storage, persisted
fw.bus.on(topic, fn) / emit(topic, payload)        // between this app's windows
fw.host.current()
fw.path.join / parent / base      fw.fmt.size / time
```

Each group needs the permission listed under *Permissions* above; a call
without it rejects with `PermissionDenied`. Emit `fs:changed` with
`{ dirs: [...] }` after mutating the filesystem (needs `remote.files.write`)
so open Files windows refresh themselves.

---

## Security model

An app is not trusted code. It runs in its own native webview on a private
origin (`appview://<identity>`), and the only thing that origin can reach is a
native gateway that knows which app is calling, which machine it was opened
on, and what it was approved for. Enforcement lives in Rust, not in the
JavaScript the app can read.

What that isolation gives you, and what it costs:

- **No shared page.** The app cannot see the desktop's DOM, the framework
  globals, other apps, or the desktop's IPC commands. Calling `invoke` on
  anything but its own gateway is rejected before it reaches a handler.
- **Content Security Policy.** No frames, workers, external scripts or forms.
  Network access exists only if `network` was requested and approved.
- **Every request is checked.** The gateway maps each operation to a
  permission, pins it to the machine the window was opened on, refuses
  requests for other machines, and rate-limits a misbehaving app.
- **Dialogs are attributed.** Confirmations and password prompts are drawn by
  the desktop with the app's name and machine on them; the app only receives
  the answer. An app cannot draw a lookalike over desktop chrome, because
  native views are hidden while a desktop menu or dialog is open.
- **Tunnels are leased.** Forwards an app opens are released when its window
  closes, and shared forwards stay up for whoever else still uses them.
- **Nothing runs until asked.** The catalog reads `manifest.json`; `index.js`
  is fetched only into an approved runtime.

Permissions are coarse on purpose: with typed lanes for files, D-Bus, tunnels
and commands, a manifest can say something meaningful, and a user can read it.
Path- or service-scoped grants would fit the same gateway later.

What remains yours: the remote machine's own permissions still apply after
the platform check, and `remote.exec` is what it says — a shell as your user.
Read the consent screen.

---

## A minimal plugin

`~/.sshdesk/plugins/uptime/manifest.json`:

```json
{ "schemaVersion": 1, "id": "uptime", "name": "Uptime", "version": "1.0.0",
  "icon": "⏱", "permissions": ["remote.exec"] }
```

`~/.sshdesk/plugins/uptime/index.js`:

```js
export function createAdapter(sdk) {
  return {
    async read() {
      const r = await sdk.exec(['uptime', '-p'])
      if (r.code !== 0) throw new Error(r.stderr)
      return r.stdout.trim()
    },
  }
}

export function createApp({ React, html, useApi }) {
  return function Uptime() {
    const api = useApi()
    const [text, setText] = React.useState('…')
    React.useEffect(() => { api.read().then(setText).catch(e => setText(String(e))) }, [api])
    return html`<div style=${{ padding: 16 }}>${text}</div>`
  }
}
```

Drop it in, press ⌘R, and it is in the dock. Opening it asks once, per
machine, for **Run commands**.


## Development checks

From the repository root:

```sh
make test
```

That runs the native tests (`cargo test --manifest-path src-tauri/Cargo.toml`)
and the loader tests (`node --experimental-vm-modules --test "ui/tests/*.test.mjs"`).

The native runtime tests cover permission mapping, host pinning, closed-app
cancellation, request budgets, manifest validation, tunnel-only embedding, and
the development proxy. The loader tests cover individual reloads,
failed-manifest recovery, ID conflicts, shipped-app restoration, token
validation, and automatic reload. `ui/tests/runtime.test.mjs` keeps the
consent copy in step with the native permission list and checks that every
shipped manifest declares what its code calls.

`make dev` serves app views from Vite too, through each app's own origin, so
edits to the runtime hot-reload; reload an app from Developer settings to pick
up edits to its own files.
