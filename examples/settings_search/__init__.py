# Vertical slice: open system Settings first, then run this project.
from xscript.android import node

print("settings_search: dumping for Search")
target = (
    node.Selector(mode=0).text("Search").find(timeout=6)
    or node.Selector(mode=0).text("搜索").find(timeout=2)
    or node.Selector(mode=1).desc("Search").find(timeout=2)
    or node.Selector(mode=1).desc("搜索").find(timeout=2)
)
if target is None:
    print("settings_search: Search control not found")
else:
    print("settings_search: clicking %r path=%s" % (target.text or target.desc, target.path))
    ok = target.click()
    print("settings_search: click=%s" % ok)
