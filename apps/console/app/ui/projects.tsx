"use client";

import type {
  DirectCommand,
  Permission,
  Project,
  Role,
  SortDir,
  Task,
  TaskComment,
  TaskEvent,
  UserWithProjects,
  Worker
} from "@claude-center/db";
import {
  Activity, ArrowDown, ArrowUp, Boxes, Bot, Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert,
  Clock, Cpu, Database, ExternalLink, FolderGit2, GitBranch, Inbox, LayoutGrid, ListTodo, LogOut,
  MessageSquare, Network, Pencil, Plus, Power, RadioTower, RotateCcw, Save, Search, Send, Server,
  ShieldCheck, Tag, Trash2, UserRound, Users, X
} from "lucide-react";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Empty, KvRow, MergeStatusBadge, StatusBadge, StatusDot, TaskTypeBadge,
  fmtDateTime, fmtTime, metaOf, postJson, type Tone
} from "./shared";
import {
  ROLE_LABEL, ROLE_OPTIONS, SPARK_CAP, TONE_COLOR, emptyOverview, fmtAgo, syncAgo,
  type CurrentUser, type Health, type Overview, type ViewKey
} from "./dashboard-shared";
import { POLL_INTERVAL_MS, usePolling } from "../lib/use-polling";
import { Drawer, Select } from "./controls";


function ProjectDrawer({
  open,
  busy,
  onClose,
  onSubmit
}: {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <Drawer open={open} title="新建项目" onClose={onClose}>
      <form className="form" onSubmit={onSubmit}>
        <div className="field">
          <label className="field-label">项目名</label>
          <input name="name" placeholder="claude-center" required />
        </div>
        <div className="field">
          <label className="field-label">Git 仓库地址</label>
          <input name="repoUrl" placeholder="https://github.com/acme/repo.git" required />
        </div>
        <div className="field">
          <label className="field-label">默认分支</label>
          <input name="defaultBranch" placeholder="main" defaultValue="main" />
        </div>
        <div className="field">
          <label className="field-label">描述</label>
          <textarea name="description" rows={3} placeholder="项目说明" />
        </div>
        <button className="btn btn-primary" disabled={busy} type="submit">
          <Plus size={16} />
          创建项目
        </button>
      </form>
    </Drawer>
  );
}

function ProjectsView({
  overview,
  onOpenCompose,
  canManageProjects
}: {
  overview: Overview;
  onOpenCompose: () => void;
  canManageProjects: boolean;
}) {
  return (
    <>
      <div className="section-head">
        <div>
          <h2 className="section-title">代码项目</h2>
          <span className="section-sub">{overview.projects.length} 个项目</span>
        </div>
        {canManageProjects ? (
          <button type="button" className="btn btn-primary btn-sm" onClick={onOpenCompose}>
            <Plus size={16} />
            新建项目
          </button>
        ) : null}
      </div>

      <section className="card">
        <div className="card-body flush">
          {overview.projects.length === 0 ? (
            <Empty
              icon={<FolderGit2 size={28} />}
              text={canManageProjects ? "暂无项目，点击右上角新建项目" : "暂无可访问的项目"}
            />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>项目</th>
                    <th>仓库</th>
                    <th>默认分支</th>
                    <th className="t-right">创建于</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.projects.map((project) => (
                    <tr key={project.id} style={{ cursor: "default" }}>
                      <td>
                        <div className="cell-stack">
                          <span className="t-title">{project.name}</span>
                          {project.description ? (
                            <span className="t-meta">{project.description}</span>
                          ) : null}
                        </div>
                      </td>
                      <td className="mono">{project.repo_url}</td>
                      <td>
                        <span className="tag">
                          <GitBranch size={13} className="ico" />
                          {project.default_branch}
                        </span>
                      </td>
                      <td className="t-right t-num">{fmtTime(project.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </>
  );
}


export { ProjectsView, ProjectDrawer };
