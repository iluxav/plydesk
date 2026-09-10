# Hello Local

A working sshdesk app with no build step.

1. Open **Settings → Developer** and enable **Developer mode**.
2. Choose **Load local app…**, then select this folder.
3. Click **Open**, edit `index.js` or `style.css`, and click **Reload**.
4. Optionally enable **Reload on changes**. Reloading resets the click counter;
   the window keeps its size and position.

Copy this directory to start a new app. Change `id` in `manifest.json` to a
unique ID. This example declares no permissions, so it opens without a consent
screen; add what your app calls (for example `"permissions": ["remote.exec"]`)
and sshdesk asks once per machine before its code runs. Editing `index.js`
keeps that approval; editing `manifest.json` asks again.
Use the supplied `React`, `html`, and `useFw`; do not bundle another React copy.
See [the plugin guide](../../plugins/README.md) for the machine SDK, shared styles,
JSX builds, and app lifecycle guidance.
