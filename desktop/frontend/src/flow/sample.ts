/** The design's sign-in flow. tests/flow-page.test.tsx checks this matches desktop/schema/golden/daily_signin.xflow. */
export const SAMPLE_FLOW = `flow daily_signin  # xflow 1
on start:
  open: app.open(package="com.example.shop")
  warm: wait(ms=2000)
  for attempt in range(0, 3):
    btn: node.find(text="签到", timeout=3)
    ok: if btn.found:
      tap: click(target=btn.node)
      msg: log(message="已签到")
      break
    else:
      retry: wait(ms=1000)
  done: log(message="流程结束")
`;
