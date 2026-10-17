# generated from daily_signin.xflow.json by XScript Desktop; do not edit, edit the flow instead
from xscript.android import action, node, system

system.open('com.example.shop')
action.sleep(2000 / 1000)
for attempt in range(0, 3):
    btn = node.Selector().text('签到').find(timeout=3)
    if (btn is not None):
        btn.click()
        print('已签到')
        break
    else:
        action.sleep(1000 / 1000)
print('流程结束')
