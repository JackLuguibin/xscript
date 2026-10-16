// New-project scaffolding. Free of `vscode` so it runs under node --test.
import * as fs from "fs";
import * as path from "path";

export interface Template {
  id: string;
  label: string;
  detail: string;
  /** relative path -> content */
  files: (name: string) => Record<string, string>;
}

/** Same rule as the device (ProjectStore): starts with a letter or underscore, then letters (incl. CJK), digits, underscores. */
export function validateProjectName(name: string): string | undefined {
  if (!name) return "Enter a project name";
  if (!/^[\p{L}_][\p{L}\p{N}_]*$/u.test(name)) return "Use letters, digits and underscores, starting with a letter or underscore";
  return undefined;
}

// build.as is AScript's project marker ({"name","version","entry"}); the device accepts projects that have it.
const buildAs = (name: string) => JSON.stringify({ name, version: "1.0.0", entry: "__init__.py" }) + "\n";

export const TEMPLATES: Template[] = [
  {
    id: "empty",
    label: "Empty project",
    detail: "__init__.py, build.as and res/",
    files: (name) => ({
      "__init__.py": "# XScript project entry. Run it with XScript: Upload and Run Project (Ctrl+Shift+R).\n",
      "build.as": buildAs(name),
      "res/.gitkeep": "",
    }),
  },
  {
    id: "hello",
    label: "Hello (screen + tap)",
    detail: "prints the screen size, finds text and taps",
    files: (name) => ({
      "__init__.py":
        "from xscript.android import action, screen\n\n" +
        "w, h = screen.size()\n" +
        'print("screen", w, h)\n' +
        "action.click(w // 2, h // 2)  # tap the middle of the screen\n",
      "build.as": buildAs(name),
      "res/.gitkeep": "",
    }),
  },
  {
    id: "ascript",
    label: "AScript style",
    detail: "from ascript.android import ... (compat layer)",
    files: (name) => ({
      "__init__.py":
        "from ascript.android.action import click\n" +
        "from ascript.android.system import Device\n\n" +
        "display = Device.display()\n" +
        "click(display.widthPixels // 2, display.heightPixels // 2)  # tap the middle of the screen\n",
      "build.as": buildAs(name),
      "res/.gitkeep": "",
    }),
  },
  {
    id: "checkin",
    label: "Daily check-in",
    detail: "open an app, tap a text button found by OCR, go home",
    files: (name) => ({
      "__init__.py":
        "# Daily check-in: open an app, wait for a button by its text, tap it.\n" +
        "from xscript.android import action, screen, system, ui\n\n" +
        'APP = "com.example.app"  # package name of the app to check in to\n' +
        'BUTTON = "签到"  # text on the check-in button (regex)\n\n' +
        "system.open(APP)\n" +
        "system.wait_for_package(APP, timeout=30)\n" +
        "if screen.ocr_click(BUTTON, timeout=15):\n" +
        '    ui.toast("checked in")\n' +
        "else:\n" +
        '    print("button not found:", BUTTON)\n' +
        "action.sleep(1)\n" +
        "action.home()\n",
      "build.as": buildAs(name),
      "res/.gitkeep": "",
    }),
  },
  {
    id: "findImage",
    label: "Find image and tap",
    detail: "template match res/img/target.png on screen and tap it",
    files: (name) => ({
      "__init__.py":
        "# Find an image on screen and tap it. Put a cropped screenshot at res/img/target.png.\n" +
        "from xscript.android import action, screen\n" +
        "from xscript.android.system import R\n\n" +
        'TARGET = R.img("target.png")\n\n' +
        "for _ in range(10):\n" +
        "    hit = screen.find_image(TARGET, confidence=0.9)\n" +
        "    if hit:\n" +
        '        print("found", hit)\n' +
        '        action.click(hit["center_x"], hit["center_y"])\n' +
        "        break\n" +
        "    action.sleep(1)\n" +
        "else:\n" +
        '    print("target.png not found on screen")\n',
      "build.as": buildAs(name),
      "res/img/.gitkeep": "",
    }),
  },
  {
    id: "ocr",
    label: "OCR read text",
    detail: "read all text lines on screen and find a number",
    files: (name) => ({
      "__init__.py":
        "# Read text on screen with OCR and pull a number out of it.\n" +
        "import re\n" +
        "from xscript.android import screen\n\n" +
        "lines = screen.ocr()  # optionally rect=(x1, y1, x2, y2) to read one area\n" +
        "for line in lines:\n" +
        '    print(line["text"], line["confidence"])\n\n' +
        'nums = [m for line in lines for m in re.findall(r"\\d+(?:\\.\\d+)?", line["text"])]\n' +
        'print("numbers:", nums)\n',
      "build.as": buildAs(name),
      "res/.gitkeep": "",
    }),
  },
  {
    id: "floatUi",
    label: "Floating window UI",
    detail: "HTML settings window (res/ui/main.html) and a floating-window menu",
    files: (name) => ({
      "__init__.py":
        "# Settings UI: show res/ui/main.html, read the values, then work from the floating window.\n" +
        "from xscript.android import ui\n" +
        "from xscript.android.system import R\n\n" +
        "settings = {}\n\n" +
        'with open(R.ui("main.html"), encoding="utf-8") as f:\n' +
        '    win = ui.Window(f.read(), width="85vw", height="50vh")\n\n\n' +
        '@win.on("start")\n' +
        "def start(value):\n" +
        "    settings.update(dict(p.split(\"=\", 1) for p in value.split(\"&\") if \"=\" in p))\n" +
        "    win.close()\n\n\n" +
        "win.show(wait=True)\n" +
        'print("settings:", settings)\n\n\n' +
        "def hello():\n" +
        '    ui.toast("hello " + settings.get("name", ""))\n\n\n' +
        'ui.float_add_menu("hello", "", hello)\n' +
        "ui.float_show()\n",
      "build.as": buildAs(name),
      "res/ui/main.html":
        '<!doctype html>\n<html><body style="font-family:sans-serif;padding:12px">\n' +
        "  <h3>Settings</h3>\n" +
        '  <label>Name <input id="name" value="xscript"></label><br><br>\n' +
        '  <label>Rounds <input id="rounds" type="number" value="3"></label><br><br>\n' +
        "  <button onclick=\"xscript.call('start', 'name=' + encodeURIComponent(name.value) + '&rounds=' + rounds.value)\">Start</button>\n" +
        "</body></html>\n",
    }),
  },
];

/** Creates parent/name from a template; refuses an existing non-empty folder. Returns the project folder. */
export function createProject(parent: string, name: string, template: Template): string {
  const bad = validateProjectName(name);
  if (bad) throw new Error(bad);
  const dir = path.join(parent, name);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) throw new Error(dir + " already exists and is not empty");
  for (const [rel, content] of Object.entries(template.files(name))) {
    const full = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf-8");
  }
  return dir;
}
