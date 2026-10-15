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
