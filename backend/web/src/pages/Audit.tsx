import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Card, DatePicker, Select, Table, Typography } from "antd";
import type { Dayjs } from "dayjs";
import { api, type AuditEntry, type Page } from "../api";
import { useAuth } from "../auth";
import { PageHeader, Pill, SearchInput } from "../components";
import { fmtTime } from "../format";

const ACTIONS: Record<string, string> = {
  "auth.login": "登录",
  "auth.login_failed": "登录失败",
  "auth.password": "修改密码",
  "user.create": "新建用户",
  "user.update": "修改用户",
  "user.delete": "删除用户",
  "token.create": "新建 API 令牌",
  "token.delete": "删除 API 令牌",
  "device.command": "下发指令",
  "device.http": "设备接口",
  "device.update": "编辑设备",
  "device.group": "批量分组",
  "device.delete": "删除设备",
  "device.logs_export": "导出运行日志",
  "device_key.create": "新建设备密钥",
  "device_key.revoke": "停用设备密钥",
  "device_key.delete": "删除设备密钥",
  "task.create": "新建任务",
  "task.update": "修改任务",
  "task.delete": "删除任务",
  "task.run": "执行任务",
  "card.create": "生成卡密",
  "card.export": "导出卡密",
  "card.revoke": "停用卡密",
  "card.restore": "恢复卡密",
  "card.unbind": "解绑卡密",
  "card.delete": "删除卡密",
  "card.extend": "卡密延期",
  "card.offline": "离线授权码",
  "card.activate": "卡密激活",
  "reseller.quota": "代理额度调整",
  "reseller.limits": "修改代理限制",
  "reseller.prices": "修改批发价",
  "reseller.payment": "登记收款",
  "reseller.adjust": "调整应付",
  "reseller.statement": "导出对账单",
  "pack.create": "提交打包",
  "pack.finish": "打包完成",
  "pack.delete": "删除打包",
  "pack.share": "生成下载链接",
  "pack.unshare": "删除下载链接",
  "script.create": "新建小程序",
  "script.update": "修改小程序",
  "script.delete": "删除小程序",
  "script.version": "上传版本",
  "script.version_delete": "删除版本",
  "script.publish": "发布版本",
  "script.unpublish": "取消发布",
  "script.deploy": "下发小程序",
  "auth.logout_session": "注销会话",
  "auth.logout_others": "注销其他会话",
  "auth.totp_enable": "开启两步验证",
  "auth.totp_disable": "关闭两步验证",
  "auth.totp_failed": "验证码错误",
  "system.backup": "备份",
  "system.backup_download": "下载备份",
  "system.cleanup": "存储清理",
  "system.maintenance": "自动维护",
  "settings.update": "修改设置",
  "import.legacy": "导入旧数据",
};

const DANGER = new Set([
  "auth.login_failed",
  "auth.totp_failed",
  "auth.totp_disable",
  "card.delete",
  "device_key.revoke",
  "user.delete",
  "card.revoke",
  "script.delete",
  "system.backup_download",
]);

const CATEGORIES: [string, string][] = [
  ["auth.", "登录与会话"],
  ["user.", "用户"],
  ["device.", "设备"],
  ["device_key.", "设备密钥"],
  ["task.", "定时任务"],
  ["card.", "卡密"],
  ["reseller.", "代理"],
  ["script.", "小程序"],
  ["pack.", "打包与分发"],
  ["system.", "备份与维护"],
  ["settings.", "设置"],
];

// What a 代理 can find in its own log.
const RESELLER_CATEGORIES = ["auth.", "token.", "card.", "reseller."];

/** 操作日志. Admins see everything; a 代理 sees its own actions and the admin's changes to its quota and limits. */
export default function AuditPage() {
  const { user } = useAuth();
  const mine = user?.role === "reseller";
  const [f, setF] = useState({ actor: "", action: "", q: "", since: 0, until: 0, page: 1, page_size: 50 });
  const list = useQuery({
    queryKey: ["audit", mine, f],
    queryFn: () => {
      if (!mine) return api.get<Page<AuditEntry>>("/api/audit", f);
      const { actor: _actor, ...own } = f; // the server already limits the log to this account
      return api.get<Page<AuditEntry>>("/api/reseller/audit", own);
    },
    placeholderData: keepPreviousData,
  });
  const ownCategory = (a: string) => RESELLER_CATEGORIES.some((p) => a.startsWith(p));
  const categories = mine ? CATEGORIES.filter(([p]) => ownCategory(p)) : CATEGORIES;
  const actions = Object.entries(ACTIONS).filter(([a]) => !mine || ownCategory(a));

  return (
    <>
      <PageHeader
        title={mine ? "操作记录" : "操作日志"}
        desc={
          mine
            ? "你的登录、发卡、停用、导出等操作，以及管理员对你额度和发卡限制的调整。"
            : "所有登录、配置变更、下发指令、发卡和打包都会记录在这里，点击行首可查看详情。"
        }
      />
      <Card className="table-card">
        <div className="toolbar">
          <Select
            placeholder="全部操作"
            allowClear
            showSearch
            optionFilterProp="label"
            style={{ width: 200 }}
            onChange={(a) => setF({ ...f, action: a ?? "", page: 1 })}
            options={[
              {
                label: "分类",
                options: categories.map(([p, label]) => ({
                  value: p,
                  label: "全部" + label,
                })),
              },
              { label: "操作", options: actions.map(([value, label]) => ({ value, label })) },
            ]}
          />
          {!mine && (
            <SearchInput placeholder="操作人" width={160} onSearch={(actor) => setF((f) => ({ ...f, actor, page: 1 }))} />
          )}
          <SearchInput placeholder="对象（卡密 / 设备 / 包名）" width={240} onSearch={(q) => setF((f) => ({ ...f, q, page: 1 }))} />
          <DatePicker.RangePicker
            showTime={{ format: "HH:mm" }}
            format="YYYY-MM-DD HH:mm"
            onChange={(r) => {
              const [a, b] = (r ?? [null, null]) as [Dayjs | null, Dayjs | null];
              setF({ ...f, since: a ? a.unix() : 0, until: b ? b.unix() : 0, page: 1 });
            }}
          />
        </div>
        <Table<AuditEntry>
          rowKey="id"
          size="middle"
          loading={list.isLoading}
          dataSource={list.data?.items}
          scroll={{ x: 900 }}
          pagination={{
            current: f.page,
            pageSize: f.page_size,
            total: list.data?.total,
            showSizeChanger: true,
            showTotal: (t) => `共 ${t} 条`,
            onChange: (page, page_size) => setF({ ...f, page, page_size }),
          }}
          expandable={{
            rowExpandable: (r) => Object.keys(r.detail ?? {}).length > 0,
            expandedRowRender: (r) => (
              <pre className="mono code-block">{JSON.stringify(r.detail, null, 2)}</pre>
            ),
          }}
          columns={[
            { title: "时间", dataIndex: "time", width: 150, render: fmtTime },
            { title: "操作人", dataIndex: "actor", width: 140 },
            {
              title: "操作",
              dataIndex: "action",
              width: 150,
              render: (a: string) => (
                <Pill
                  tone={
                    DANGER.has(a)
                      ? "red"
                      : a.startsWith("auth.")
                        ? "blue"
                        : a === "script.publish" || a === "script.deploy"
                          ? "violet"
                          : a.startsWith("system.")
                            ? "amber"
                            : "gray"
                  }
                >
                  {ACTIONS[a] ?? a}
                </Pill>
              ),
            },
            { title: "对象", dataIndex: "target", ellipsis: true, render: (t: string) => <span className="mono">{t}</span> },
            {
              title: "IP",
              dataIndex: "ip",
              width: 130,
              render: (ip: string) => <Typography.Text type="secondary">{ip}</Typography.Text>,
            },
          ]}
        />
      </Card>
    </>
  );
}
