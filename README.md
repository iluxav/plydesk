# plydesk

A desktop for machines you reach over SSH. Files, services, packages,
processes, a terminal and VS Code on any Linux box you can log into — with
nothing installed on it.

Until September 2026 this project was called sshdesk. The first launch under
the new name carries over saved machines, preferences, app approvals, and
`~/.sshdesk`; software installed on a remote under `~/.sshdesk/opt` is moved
the next time that machine is checked.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/iluxav/plydesk/main/install.sh | sh
```

macOS, Apple Silicon or Intel. The installer checks the published SHA256 before
writing anything, and puts `plydesk.app` in `/Applications`.

`curl` rather than a download link on purpose: the app is not notarised by
Apple, and macOS quarantines anything a *browser* fetches — a downloaded
archive would be refused by Gatekeeper. Nothing curl fetches is quarantined, so
installed this way it simply opens. Removing it is `rm -rf
/Applications/plydesk.app`; nothing else is written outside `~/.plydesk`.

## What it does

Connect with `user@host` and you get a desktop for that machine:

- **Files** over the SFTP subsystem — typed attributes, server-side copy, and
  drag to and from Finder
- **Services** over systemd's D-Bus API, with live updates pushed from the box
  rather than polled
- **Packages** through PackageKit, so search and install work the same on apt,
  dnf or zypper
- **Processes** read from `/proc`, and listening ports from `ss`
- **A terminal**, a code editor, an image viewer, and **VS Code** — installed
  on demand into `~/.plydesk/opt`, needing no root

Nothing is installed on the remote to make the first five work. Every one of
them rides the single SSH connection you already opened.

## Why it is built this way

Linux desktops do not shell out; they call typed IPC. `systemctl` is itself a
D-Bus client and `ss` queries netlink, so parsing their output means asking a
CLI to render a typed API into text and turning it back into data — and that
text is the part that changes between distro releases.

So plydesk uses the protocol wherever one exists, in three tiers:

1. **A real protocol** — files over SFTP, system state over the remote D-Bus,
   both reached through the connection already open
2. **No protocol, but a stable kernel ABI** — `/proc` rather than `ps` output
3. **The escape hatch** — a persistent shell, for everything with no schema

The result is that a service list costs 34 ms and spawns no process on the
remote, where the shell path cost around four times that and spent most of it
starting `systemctl`.

## Apps

Built-in apps and plugins are the same thing to the desktop. A plugin is a
directory with a `manifest.json` that declares what it needs — the permissions
it uses, the tokens it owns, the content types it opens, the software it
requires on the remote — and an `index.js` that runs in its own isolated view
once you have approved that access. VS Code is a plugin, and adding it needed
no change to plydesk itself.

See [`plugins/README.md`](plugins/README.md) for the plugin guide and the
security model, and [`examples/hello-app`](examples/hello-app) for a starting
point.

## Building

```sh
make run                    # rebuild and launch
make test                   # unit tests: core, app runtime, desktop UI
make probe HOST=user@box    # verify the whole stack against a real machine
make help                   # every target
```

`make probe` is the useful one: it asserts the whole stack against a live host
by content rather than exit code, and has caught every interesting bug in this
codebase. [`docs/architecture.md`](docs/architecture.md) explains how the
pieces fit, what was measured, and what is not done yet.
