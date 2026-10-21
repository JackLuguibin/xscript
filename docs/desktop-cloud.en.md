# Desktop client: Cloud page

The desktop client's **Cloud** page (sidebar, Ctrl+6) manages a self-hosted admin backend (`backend/xscript_server`). Every request goes through the Python side; the page itself never talks to the network.

![Cloud devices and batch command (demo data)](images/desktop-cloud-devices.png)

## Connect

1. In the backend web console, open **Account → API tokens** and create a token (starts with `xsk_`, shown once). The token carries that account's role: admin, operator or viewer. Agent accounts cannot be used.
2. In the desktop client, open **Cloud → Connect**, enter the backend URL and the token, and press **Connect**. Only `https://` URLs are accepted, plus `http://localhost` / `http://127.0.0.1` for local testing.
3. The token is stored only in the system credential store (entry `backend/<url>`). It never appears in logs, the database or RPC replies. If it expires or is revoked, the Connect section asks for a new one.

## Sections

| Section | What it does | Role |
| --- | --- | --- |
| Devices | Backend device table with search, group / app / online filters and paging; selection survives paging and filtering. A device whose last run crashed shows a red **Crashed** badge (hover for project, exit code and the last stderr line) until its next run starts; the state filter's **Crashed** option lists only those devices. **Batch command** runs or stops a project on the selected devices and lists each result. | view: all; command: operator+ |
| Screens | Live thumbnails of online devices (pausable), relayed from each device's `/screen` through the backend. | operator+ |
| Logs | Search a device's stored run logs (text and stream filters, page back; works while the device is offline). | all |
| Tasks | Server-side scheduled tasks: enable / disable, run now, delete, create run / stop tasks (daily or interval). | view: all; edit: operator+ |
| Deploy | Upload the flow open in the flow editor as a new mini-program version (not published, so hot updates are unaffected), install it on a group's online devices and run it; roll back from the version history. | admin |
| Pack | APK packaging jobs: status, log, cancel, **Save APK…** | view / save: all; cancel: operator+ |
| Web console | Opens backend pages in the system browser. Not embedded, so the desktop token never reaches a web page. | all |

Buttons the role can't use are greyed out with the reason; the backend still checks every request.

## End-to-end check

`scripts/desktop_cloud_e2e.py` starts a local backend with admin and viewer tokens (written only to a 0600 file) and three demo phones, then drives the desktop `cloud.*` RPCs against an emulator app. See `desktop/README.md`, section 「P4 云控」, for the commands. The check ends by calling `cloud.close()` on the app, which clears the cloud URL the app had saved.
