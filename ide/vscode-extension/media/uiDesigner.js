// Webview side of the XScript UI designer (src/uiDesigner.ts). The view itself is shared with the Web IDE
// (media/ui-designer.js and media/ui-form.js, copied from android/app/src/main/assets/tools/ at build time);
// this adapter only connects it to the extension: edits go out as {type:"edit", spec}, specs come back in.
(function () {
  const vscode = acquireVsCodeApi();
  const designer = XSUiDesigner.mount(document.getElementById("app"), {
    kinds: document.body.getAttribute("data-kinds").split(","),
    post: (m) => vscode.postMessage(m),
    lang: "en",
  });
  window.addEventListener("message", (e) => designer.receive(e.data));
  vscode.postMessage({ type: "ready" });
})();
