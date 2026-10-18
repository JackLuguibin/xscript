"""Server-side 定时任务 CRUD and manual runs."""

from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import select
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from ..deps import Principal, ctx, db_session, operator, record, viewer
from ..hub import next_run, validate_daily
from ..models import Script, Task

router = APIRouter(prefix="/api/tasks", tags=["tasks"])


class TaskIn(BaseModel):
    name: str = Field(default="", max_length=64)
    target: str = Field(default="all", min_length=1, max_length=512)
    command: dict[str, Any]
    daily: str | None = None
    every: float | None = Field(default=None, gt=0, le=60 * 24 * 30)
    enabled: bool = True

    @model_validator(mode="after")
    def _check(self):
        if not self.command.get("path"):
            raise ValueError("command 需要 path")
        if bool(self.daily) == bool(self.every):
            raise ValueError("daily 和 every 二选一")
        if self.daily:
            self.daily = validate_daily(self.daily)
        return self


def _require_deploy_rights(p: Principal, command: dict[str, Any]) -> None:
    """Scheduled deploys ship code to devices, so only admins may create, run, change or delete them."""
    if command.get("path") == "script_deploy" and not p.at_least("admin"):
        raise HTTPException(403, "定时下发小程序需要管理员权限")


class TaskPatch(BaseModel):
    enabled: bool | None = None
    name: str | None = Field(default=None, max_length=64)


def task_out(t: Task, now: float | None = None) -> dict[str, Any]:
    now = now or time.time()
    return {"id": t.id, "name": t.name, "target": t.target, "command": t.command, "daily": t.daily,
            "every": t.every, "enabled": t.enabled, "last_run": int(t.last_run) or None,
            "next_run": int(next_run(t.daily, t.every, t.last_run, now) or 0) if t.enabled else None,
            "last_result": t.last_result, "created_by": t.created_by, "created_at": t.created_at}


@router.get("")
def list_tasks(p: Principal = Depends(viewer), s: Session = Depends(db_session)):
    return {"items": [task_out(t) for t in s.scalars(select(Task).order_by(Task.id))]}


@router.post("")
def create_task(body: TaskIn, request: Request, p: Principal = Depends(operator), s: Session = Depends(db_session)):
    if body.command.get("path") == "script_deploy":
        # Scheduled deploys ship code to devices, like the deploy button.
        _require_deploy_rights(p, body.command)
        try:
            script_id = int(body.command.get("script_id") or 0)
        except (TypeError, ValueError):
            raise HTTPException(400, "script_id 必须是整数") from None
        if not s.get(Script, script_id):
            raise HTTPException(400, "小程序不存在")
    # An "every" task waits one interval before its first run; a daily task runs at the next HH:MM.
    t = Task(name=body.name, target=body.target, command=body.command, daily=body.daily, every=body.every,
             enabled=body.enabled, last_run=time.time(), created_by=p.username)
    s.add(t)
    s.flush()
    record(request, s, p, "task.create", str(t.id), {"target": t.target, "command": t.command,
                                                     "daily": t.daily, "every": t.every})
    s.commit()
    return task_out(t)


@router.patch("/{task_id}")
def update_task(task_id: int, body: TaskPatch, request: Request, p: Principal = Depends(operator),
                s: Session = Depends(db_session)):
    t = s.get(Task, task_id)
    if t is None:
        raise HTTPException(404, "任务不存在")
    _require_deploy_rights(p, t.command or {})
    if body.enabled is not None:
        t.enabled = body.enabled
    if body.name is not None:
        t.name = body.name
    record(request, s, p, "task.update", str(task_id), body.model_dump(exclude_none=True))
    s.commit()
    return task_out(t)


@router.delete("/{task_id}")
def delete_task(task_id: int, request: Request, p: Principal = Depends(operator), s: Session = Depends(db_session)):
    t = s.get(Task, task_id)
    if t is None:
        raise HTTPException(404, "任务不存在")
    _require_deploy_rights(p, t.command or {})
    s.delete(t)
    record(request, s, p, "task.delete", str(task_id))
    s.commit()
    return {"ok": True}


@router.post("/{task_id}/run")
async def run_task(task_id: int, request: Request, p: Principal = Depends(operator)):
    c = ctx(request)

    def _load():
        with c.db.session() as s:
            t = s.get(Task, task_id)
            return (t.target, dict(t.command)) if t else None

    found = await run_in_threadpool(_load)
    if found is None:
        raise HTTPException(404, "任务不存在")
    _require_deploy_rights(p, found[1])
    return await c.scheduler.run_task(task_id, found[0], found[1], by=p.username)
