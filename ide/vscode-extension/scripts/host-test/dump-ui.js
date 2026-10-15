// usage: node dump-ui.js <port>  -> prints, as JSON, what is visible in every VS Code window (notifications, dialogs, welcome
// page, chat panel, sign-in text) via the Chromium DevTools protocol (VS Code started with --remote-debugging-port).
// Used by vscode-no-prompt-check.sh to prove a run shows nothing that asks for a login.
const port = process.argv[2];
(async () => {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  for (const t of targets.filter(t => t.type === 'page')) {
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise(r => ws.addEventListener('open', r));
    const res = await new Promise(r => {
      ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id === 1) r(m); });
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { returnByValue: true, expression: `(() => {
        const q = s => [...document.querySelectorAll(s)].map(e => e.innerText.trim()).filter(Boolean);
        return JSON.stringify({ title: document.title,
          notifications: q('.notifications-toasts .notification-list-item'),
          dialogs: q('.monaco-dialog-box, .dialog-shadow'),
          editorTabs: q('.tab .label-name'),
          welcome: q('.gettingStartedContainer, .welcomePageContainer').map(s => s.slice(0,200)),
          chatPanel: q('.chat-view-welcome-container, .interactive-session, .chat-setup-view, .chat-widget').map(s => s.slice(0,300)),
          accounts: q('.activitybar .action-item[aria-label*="ccount"], .activitybar .action-item[aria-label*="Sign"]'),
          statusbar: q('.statusbar-item').slice(0,30),
          visibleSignIn: [...document.body.innerText.matchAll(/.{0,60}(sign in|Sign in|Sign In|log in|Log in|login|GitHub|Copilot|keychain|password).{0,60}/g)].map(m => m[0].replace(/\\s+/g,' ')).slice(0,15) }); })()` } }));
    });
    console.log(res.result?.result?.value ?? JSON.stringify(res));
    ws.close();
  }
})();
