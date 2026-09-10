// Identity, window size, and permissions live in manifest.json beside this
// file. This module only builds the UI; it runs in the app's own view.
export function createApp({ React, html, useFw }) {
  return function HelloLocal() {
    const fw = useFw()
    const [count, setCount] = React.useState(0)
    return html`<div class="desk-app hello-local">
      <div class="app-toolbar"><strong>My first local app</strong></div>
      <main class="hello-local-content">
        <span class="hello-local-label">DEVELOPING ON THIS MAC</span>
        <h1>Hello from your local app</h1>
        <p>Edit this folder in your editor, then reload it in Settings → Developer.</p>
        <button class="app-button" onClick=${() => setCount(n => n + 1)}>Clicks: ${count}</button>
      </main>
      <footer class="app-statusbar">${fw.host.current()}</footer>
    </div>`
  }
}
