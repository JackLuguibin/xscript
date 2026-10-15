// macOS: `osascript -l JavaScript windows.js` lists the on-screen windows of apps that could be showing a login /
// keychain / Gatekeeper dialog (SecurityAgent, CoreServicesUIAgent, UserNotificationCenter, Keychain Access, loginwindow
// panels), plus VS Code's own windows. No Screen Recording permission needed (owner names only).
ObjC.import('CoreGraphics');
const l = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, 0)));
console.log(JSON.stringify(l.filter(w => /^(Code|Electron|SecurityAgent|CoreServicesUIAgent|UserNotificationCenter|Keychain Access|coreautha)/.test(w.kCGWindowOwnerName))
  .map(w => w.kCGWindowOwnerName + ':L' + w.kCGWindowLayer)));
