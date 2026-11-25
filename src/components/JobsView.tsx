import { Download, RotateCw, FileText, AlertTriangle } from "lucide-react";

import { api } from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { useApp } from "@/lib/store";
import { Badge, Button } from "@/components/ui/primitives";

const STATUS_TEXT: Record<string, string> = {
  pending: "等待中",
  running: "进行中",
  failed: "失败",
  done: "已完成",
};

export function JobsView() {
  const jobs = useApp((state) => state.jobs);
  const loadJobs = useApp((state) => state.loadJobs);
  const toast = useApp((state) => state.toast);

  const running = jobs.filter((job) => job.status === "running").length;
  const failed = jobs.filter((job) => job.status === "failed").length;

  const retry = async () => {
    try {
      await api.retryJobs();
      await loadJobs();
      toast("success", "失败任务已重新入队");
    } catch (error) {
      toast("error", error instanceof Error ? error.message : String(error));
    }
  };

  const enqueueTranscribe = async () => {
    try {
      const count = await api.enqueueTranscribe(200);
      await loadJobs();
      toast("info", count > 0 ? `已加入 ${count} 条转写任务` : "没有需要转写的语音");
    } catch (error) {
      toast("error", error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="main">
      <header className="main__head">
        <div className="main__titles">
          <div className="main__title">任务</div>
          <div className="main__sub">
            {failed > 0 ? `${failed} 个失败` : running > 0 ? `${running} 个进行中` : `${jobs.length} 项`}
          </div>
        </div>
        <div className="main__actions">
          <Button
            variant="ghost"
            size="sm"
            icon={<FileText size={13} />}
            onClick={() => void enqueueTranscribe()}
          >
            批量转写
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={<RotateCw size={13} />}
            disabled={failed === 0}
            onClick={() => void retry()}
          >
            重试
          </Button>
        </div>
      </header>

      <div className="jobs-view">
        {jobs.length === 0 ? (
          <div className="empty">
            <div className="empty__title">暂无任务</div>
          </div>
        ) : (
          jobs.map((job) => (
            <div className="job-row" key={job.id}>
              <span style={{ color: "var(--text-3)", display: "grid", placeItems: "center", width: 26 }}>
                {job.kind === "download" ? <Download size={15} /> : <FileText size={15} />}
              </span>
              <div className="job-row__main">
                <div className="job-row__title">
                  {job.kind === "download" ? "下载语音" : "转写语音"}
                  {job.title ? ` · ${job.title}` : ""}
                </div>
                <div className="job-row__sub">
                  {formatRelative(job.createdAt)}
                  {job.attempts > 0 ? ` · 重试 ${job.attempts} 次` : ""}
                </div>
                {job.lastError ? (
                  <div className="job-row__err">
                    <AlertTriangle size={11} style={{ verticalAlign: -1, marginRight: 4 }} />
                    {job.lastError}
                  </div>
                ) : null}
              </div>
              <Badge
                kind={
                  job.status === "failed"
                    ? "danger"
                    : job.status === "running"
                      ? "group"
                      : job.status === "pending"
                        ? "warn"
                        : undefined
                }
              >
                {STATUS_TEXT[job.status] ?? job.status}
              </Badge>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
