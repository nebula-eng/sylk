import { MessageSquare, BarChart3, ListChecks, Settings, Mic } from "lucide-react";

import { useApp, type View } from "@/lib/store";
import { cn } from "@/components/ui/primitives";

const NAV: { view: View; label: string; icon: typeof MessageSquare }[] = [
  { view: "voices", label: "语音", icon: MessageSquare },
  { view: "stats", label: "统计", icon: BarChart3 },
  { view: "jobs", label: "任务", icon: ListChecks },
];

export function Rail({ minimal = false }: { minimal?: boolean }) {
  const view = useApp((state) => state.view);
  const setView = useApp((state) => state.setView);
  const connection = useApp((state) => state.connection);
  const jobs = useApp((state) => state.jobs);
  const setSettingsOpen = useApp((state) => state.setSettingsOpen);

  const pending = jobs.filter((job) => job.status === "pending" || job.status === "running").length;
  const failed = jobs.filter((job) => job.status === "failed").length;

  const statusClass =
    connection.status === "online"
      ? "is-online"
      : connection.status === "error"
        ? "is-error"
        : "";

  return (
    <nav className="rail" aria-label="主导航">
      <div className="rail__brand" title="Sylk · 声匣">
        <Mic size={17} strokeWidth={2.2} />
      </div>

      <div className="rail__nav">
        {minimal
          ? null
          : NAV.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.view}
                  type="button"
                  className={cn("rail-btn", view === item.view && "is-active")}
                  title={item.label}
                  aria-label={item.label}
                  aria-current={view === item.view ? "page" : undefined}
                  onClick={() => setView(item.view)}
                >
                  <Icon size={18} strokeWidth={1.9} />
                  {item.view === "jobs" && (pending > 0 || failed > 0) ? (
                    <span className="rail-btn__badge">{pending + failed}</span>
                  ) : null}
                </button>
              );
            })}
      </div>

      <div className="rail__foot">
        <div className={cn("rail__status", statusClass)} title={connection.message || "尚未连接"} />
        <button
          type="button"
          className="rail-btn"
          title="设置"
          aria-label="设置"
          onClick={() => setSettingsOpen(true)}
        >
          <Settings size={17} strokeWidth={1.9} />
        </button>
      </div>
    </nav>
  );
}
