# Architecture

How sshdesk is put together, what was measured, and what is still open. The
product overview and install steps are in the [README](../README.md).

The idea it proves: **a local GUI that drives real Linux boxes over plain SSH,
with nothing installed on the remote.**

```
                        ┌─ SFTP subsystem ────────▶ files      (typed)
ui (webview) ──IPC──▶   ├─ forwarded D-Bus socket ▶ systemd    (typed, + signals)
             Rust core  ├─ /proc via one command ─▶ processes  (kernel ABI)
                        └─ persistent bash shell ─▶ anything   (escape hatch)

                        all four multiplex over ONE ssh ControlMaster
```

## Run

```sh
make run     # rebuild (UI + Rust) and launch
make restart # relaunch the existing build
make help    # all targets
```

**Tauri embeds `ui/index.html` into the binary at build time.** Editing the HTML has
no effect until you rebuild — always use `make run`, never just relaunch the binary.

On macOS, `make run` builds and launches `src-tauri/target/release/bundle/macos/sshdesk.app`.
`make restart` uses the same app bundle, so embedded apps such as VS Code keep the
same browser profile. Launch this bundle when testing saved settings; the loose
executable and copies with a different bundle identifier use separate WebKit data.
`make dev` is still available for hot reload and uses a separate development profile.

Enter `user@host`, hit Connect. Sudo password is only needed for actions that change state.

## Keyboard navigation

Open **Settings → Keyboard** to record, remove, or reset desktop shortcuts. They
are saved on this Mac and apply across connected machines, including embedded VS Code.

| Action | Default shortcut |
| --- | --- |
| Search apps and files | Option-Space |
| Snap left / right | Option-Command-Left / Right |
| Maximize / restore | Option-Command-Up / Down |
| Next / previous window | Command-backtick / Shift-Command-backtick |
| Minimize | Option-Command-M |

Hold the switch shortcut's modifier to browse recent windows, then release to
select. Escape cancels. Minimized windows and windows on other connected machines
are included. Layout actions also appear in the Window menu.

For **Command-Tab**, choose **Use ⌘Tab** in Keyboard settings and allow sshdesk in
**macOS System Settings → Privacy & Security → Accessibility**. The native input
layer intercepts assigned combinations only while sshdesk's main window is focused;
clicking outside returns control to macOS. Capture is off by default. Normal
desktop shortcuts use an app-local monitor and do not require Accessibility access.
Command-Q and Command-Option-Escape remain available. No keystrokes are logged.

Run the keyboard and window-layout checks with Node 24:
`node --test ui/tests/keyboard.test.mjs`, or everything with `make test`.

## Apps are isolated

Extension apps (Ports, Services, System, VS Code, and anything under
`~/.sshdesk/plugins` or a Developer-mode folder) do not run in the desktop
page. Each window gets its own native webview on a private origin, and the
only thing it can reach is a Rust gateway that checks every request against
the app's `manifest.json` permissions and the machine the window was opened
on. The first time an app opens on a machine, sshdesk lists what it asks for
and waits for your approval before running its code; approvals are per app
and per machine, and can be revoked in **Settings → Apps & Extensions**.
[plugins/README.md](../plugins/README.md) has the permission list and the
security model.

## The three decisions that matter

**Use the protocol where one exists.** A Linux GUI does not shell out — it calls
D-Bus, and `systemctl` is itself just a D-Bus client. So files go over the SFTP
subsystem and system state over the remote system bus, reached by forwarding
`/run/dbus/system_bus_socket` with `-O forward` on the connection we already
hold. Both are typed in and out, both need nothing installed on the remote, and
neither spawns a process there — which is where the latency was.

**Shell out to the real `ssh` binary.** Not a Rust or JS SSH library. That inherits
ControlMaster multiplexing, `~/.ssh/config`, ssh-agent, `ProxyJump`, `known_hosts` and
host-key verification — and keeps every line of crypto out of this codebase. "SSH already
has the security; don't reinvent it" taken literally.

**One persistent shell per host, not a channel per command.** Commands are written to a
long-lived `bash --noprofile --norc` stdin and framed with generated delimiters.

## Measured against a Raspberry Pi on LAN (4.2 ms ping)

| Approach | Latency |
|---|---|
| Fresh SSH connection per command | 390–800 ms |
| Multiplexed channel per command | ~40 ms |
| **Persistent shell (this)** | **~19 ms** |
| No-op round trip | **4.9 ms** — equal to ping, the physical floor |

Of the 19 ms, ~4 ms is network and ~15 ms is the remote spawning `systemctl`/`ps`/`ss`.
**The remote process costs 4× the entire network path**, so transport-layer optimisation
(WASM, service workers) targets the wrong 1 ms. The wins are batching, streaming and
caching.

## What's verified

Against a real Ubuntu Pi (systemd 257, OpenSSH 10.0p2), via `core/src/bin/probe.rs`:

- SFTP subsystem opens over the existing ControlMaster; 11 extensions detected,
  including `copy-data`, `posix-rename` and `statvfs`
- write → read round trip is **byte-identical even when the content contains an
  old frame marker** (`__SD_OUT_1__`), which used to desync the shell parser
- `café-tèst.txt` lists correctly — non-ASCII names no longer break anything
- server-side copy verified **by content**, not exit code
- typed attrs: size, kind, mode string, owner name
- `statvfs`: 88.5 GB free of 125.3 GB, as numbers
- D-Bus: 193 services in 34 ms, `Version = 257.9-0ubuntu2.5`, `Architecture = arm64`
- signal subscription accepted; a live signal was received during the run
- privileged write **correctly refused by polkit** — the documented boundary
- 167 processes from `/proc`, every one resolved to a user name via `/etc/passwd`
- ownership filter intact: 11 listening ports, 2 mine
- D-Bus 4.5 ms vs shell-plus-spawn 9.2 ms on the same box

```sh
./core/target/release/sshdesk-probe iluxa@10.168.168.226
```

## Design notes

**`sudo -S`, never `--askpass`.** Ubuntu 25.10 ships sudo-rs, which does not implement
`--askpass` — that is exactly what breaks Cockpit's admin mode on a default install.
`-S` works on both classic sudo and sudo-rs.

**Machine-readable output only.** `systemctl -o json`, explicit `ps -o` fields. Parsing
human-formatted output is how these tools rot across distros.

**Ownership comes free.** Non-root `ss -ltnp` only fills the `users:(...)` field for your
own processes, so it *is* the permission check — no denylist, and other tenants' ports
can never be acted on.

**Unit names are never trusted back as shell input**, even though they came from the
remote. Actions are whitelisted.

## Not done

- Password is held in the UI and passed per action. Real version wants a cached sudo
  timestamp or an askpass helper.
- No streaming yet — refresh is manual. A remote watcher loop pushing changes down one
  channel costs zero round trips.
- One host at a time in the UI; the backend already keys by target and holds many.
- UI is a spike, not a design. The desktop shell is yours to build.
