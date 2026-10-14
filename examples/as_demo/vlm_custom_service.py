"""Run against your own /vision/locate + /vision/ask server.

Set ASCRIPT_AI_BASE_URL and ASCRIPT_AI_KEY in the script environment first.
The selected service receives screenshots. No vendor endpoint is built in.
"""
import os
from ascript.android.vlm import asai

asai.init(api_key=os.environ["ASCRIPT_AI_KEY"], base_url=os.environ["ASCRIPT_AI_BASE_URL"])
print(asai.status())
print(asai.find("设置按钮"))
print(asai.ask("当前页面有哪些选项？"))
