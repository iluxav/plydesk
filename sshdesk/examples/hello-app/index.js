export const manifest = {
  id: 'hello-local',
  name: 'Hello Local',
  description: 'A starting point for your own sshdesk app.',
  version: '1.0.0',
  icon: 'lucide:code-xml',
  window: { w: 580, h: 380 },
}

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
