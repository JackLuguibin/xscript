/** Scratch project 在手机上试运行 writes into (never the user's project). */
export const UI_TRY_PROJECT = "_ui_try";
export function uiTryMain(name: string): string {
  return `import json\nfrom ui_${name} import show\n\nvalues = show()\nprint("界面返回：" + json.dumps(values, ensure_ascii=False), flush=True)\n`;
}
