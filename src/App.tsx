import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

type Profile = {
  name: string;
  status: string;
  arch: string;
  cpus: number;
  memory: number;
  disk: number;
  runtime: string;
};
type Container = {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string;
};
type Environment = { colimaVersion: string; dockerVersion: string | null };
type Resources = { cpus: number; memoryGiB: number; diskGiB: number };
type OperationResult = { message: string; output: string };
type ProfileAction =
  "create" | "start" | "stop" | "restart" | "configure" | "delete";
type Modal =
  | { type: "create" }
  | { type: "configure"; profile: Profile }
  | { type: "delete"; profile: Profile }
  | null;
type Activity = {
  title: string;
  output: string;
  time: string;
  failed: boolean;
};
const gib = (bytes: number) => Math.round(bytes / 1024 ** 3);
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    cube: (
      <>
        <path d="m12 3 9 5v8l-9 5-9-5V8Z" />
        <path d="m3 8 9 5 9-5M12 13v8M7.5 5.5l9 5" />
      </>
    ),
    play: <path d="m8 5 11 7-11 7Z" />,
    stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
    refresh: (
      <>
        <path d="M20 7v5h-5M4 17v-5h5" />
        <path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    settings: (
      <>
        <path d="M4 7h16M4 17h16" />
        <circle cx="9" cy="7" r="3" />
        <circle cx="15" cy="17" r="3" />
      </>
    ),
    trash: (
      <>
        <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" />
      </>
    ),
    cpu: (
      <>
        <rect x="6" y="6" width="12" height="12" rx="2" />
        <rect x="9" y="9" width="6" height="6" rx="1" />
        <path d="M9 3v3m6-3v3M9 18v3m6-3v3M3 9h3m-3 6h3m12-6h3m-3 6h3" />
      </>
    ),
    memory: (
      <>
        <rect x="3" y="7" width="18" height="10" rx="2" />
        <path d="M7 10v4m5-4v4m5-4v4M7 17v3m5-3v3m5-3v3" />
      </>
    ),
    disk: (
      <>
        <rect x="3" y="5" width="18" height="14" rx="3" />
        <path d="M3 13h18M7 16h.01M11 16h.01" />
      </>
    ),
    terminal: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="3" />
        <path d="m7 9 3 3-3 3m6 0h4" />
      </>
    ),
    search: (
      <>
        <circle cx="10" cy="10" r="6" />
        <path d="m15 15 5 5" />
      </>
    ),
    close: <path d="m6 6 12 12M6 18 18 6" />,
    check: <path d="m5 12 4 4L19 6" />,
    arrow: <path d="m9 6 6 6-6 6" />,
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? paths.cube}
    </svg>
  );
}

function Dialog({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={wide ? "dialog dialog-wide" : "dialog"}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      aria-label={title}
    >
      <div className="dialog-heading">
        <h2>{title}</h2>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="閉じる"
          data-testid={wide ? "close-logs" : "close-dialog"}
        >
          <Icon name="close" />
        </button>
      </div>
      {children}
    </dialog>
  );
}

function ProfileForm({
  modal,
  busy,
  onClose,
  onSubmit,
}: {
  modal: Exclude<Modal, null | { type: "delete" }>;
  busy: boolean;
  onClose: () => void;
  onSubmit: (name: string, resources: Resources) => void;
}) {
  const profile = modal.type === "configure" ? modal.profile : null;
  const [name, setName] = useState(profile?.name ?? "");
  const [resources, setResources] = useState<Resources>({
    cpus: profile?.cpus || 2,
    memoryGiB: profile ? gib(profile.memory) || 2 : 2,
    diskGiB: profile ? gib(profile.disk) || 100 : 100,
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit(name, resources);
  };
  return (
    <Dialog
      title={profile ? "リソースを設定" : "プロファイルを作成"}
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <p className="muted dialog-description">
          {profile
            ? "設定を適用し、このプロファイルを起動します。"
            : "独立した Docker 環境を作成して起動します。"}
        </p>
        <label className="field">
          プロファイル名
          <input
            autoFocus
            data-testid="profile-name"
            value={name}
            disabled={!!profile || busy}
            required
            pattern="(?!colima(?:-|$))[a-z][a-z0-9-]{0,39}"
            maxLength={40}
            placeholder="例: development"
            onChange={(event) => setName(event.target.value)}
          />
          <span className="field-hint">
            半角小文字で始まる英数字・ハイフン、40 文字以内。 colima と colima-
            で始まる名前は予約されています。
          </span>
        </label>
        <div className="resource-fields">
          <label className="field">
            CPU
            <span className="input-unit">
              <input
                data-testid="resource-cpus"
                type="number"
                required
                min={1}
                max={128}
                value={resources.cpus}
                disabled={busy}
                onChange={(event) =>
                  setResources({
                    ...resources,
                    cpus: Number(event.target.value),
                  })
                }
              />
              <span>コア</span>
            </span>
          </label>
          <label className="field">
            メモリ
            <span className="input-unit">
              <input
                data-testid="resource-memory"
                type="number"
                required
                min={1}
                max={256}
                value={resources.memoryGiB}
                disabled={busy}
                onChange={(event) =>
                  setResources({
                    ...resources,
                    memoryGiB: Number(event.target.value),
                  })
                }
              />
              <span>GiB</span>
            </span>
          </label>
          <label className="field">
            ディスク
            <span className="input-unit">
              <input
                data-testid="resource-disk"
                type="number"
                required
                min={profile ? Math.max(5, gib(profile.disk)) : 5}
                max={2048}
                value={resources.diskGiB}
                disabled={busy}
                onChange={(event) =>
                  setResources({
                    ...resources,
                    diskGiB: Number(event.target.value),
                  })
                }
              />
              <span>GiB</span>
            </span>
          </label>
        </div>
        <p className="notice">
          {profile
            ? "ディスク容量は拡張できます。縮小にはプロファイルの再作成が必要です。"
            : "初回起動時は VM イメージのダウンロードに数分かかる場合があります。"}
        </p>
        <div className="dialog-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            キャンセル
          </button>
          <button
            className="primary"
            data-testid="profile-submit"
            disabled={busy}
          >
            {busy ? "処理中…" : profile ? "設定を適用して起動" : "作成して起動"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function DeleteForm({
  profile,
  busy,
  onClose,
  onSubmit,
}: {
  profile: Profile;
  busy: boolean;
  onClose: () => void;
  onSubmit: (deleteData: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [deleteData, setDeleteData] = useState(false);
  return (
    <Dialog title="プロファイルを削除" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (name === profile.name) onSubmit(deleteData);
        }}
      >
        <p className="dialog-description">
          <strong>{profile.name}</strong> の仮想マシンと設定を削除します。
        </p>
        <label className="checkbox-field">
          <input
            data-testid="delete-data"
            type="checkbox"
            checked={deleteData}
            disabled={busy}
            onChange={(event) => setDeleteData(event.target.checked)}
          />
          <span>コンテナ・イメージ・ボリュームのデータも削除する</span>
        </label>
        <p className="notice">
          {deleteData
            ? "データを含めて完全に削除します。この操作は取り消せません。"
            : "データディスクを残します。同じ名前で再作成すると再利用できます。"}
        </p>
        <label className="field">
          確認のため「{profile.name}」を入力
          <input
            autoFocus
            data-testid="delete-confirm-name"
            value={name}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
            autoComplete="off"
          />
        </label>
        <div className="dialog-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            キャンセル
          </button>
          <button
            className="danger"
            data-testid="delete-submit"
            disabled={busy || name !== profile.name}
          >
            削除する
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export default function App() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selected, setSelected] = useState("");
  const [environment, setEnvironment] = useState<Environment | null>(null);
  const [containers, setContainers] = useState<Container[]>([]);
  const [containerError, setContainerError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState("");
  const busyRef = useRef(false);
  const [elapsed, setElapsed] = useState(0);
  const [modal, setModal] = useState<Modal>(null);
  const [logs, setLogs] = useState<{
    profile: string;
    container: Container;
    text: string;
    loading: boolean;
  } | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [filter, setFilter] = useState("");
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const profile = profiles.find((item) => item.name === selected);
  const running = profile?.status === "Running";
  const stopped = profile?.status === "Stopped";
  const docker = profile?.runtime.startsWith("docker");
  const containerGeneration = useRef(0);

  const refreshProfiles = useCallback(async (preferred?: string) => {
    const result = await invoke<Profile[]>("list_profiles");
    setProfiles(result);
    setSelected((current) =>
      result.some((item) => item.name === (preferred ?? current))
        ? (preferred ?? current)
        : (result[0]?.name ?? ""),
    );
    return result;
  }, []);

  const refreshContainers = useCallback(async (name: string) => {
    const generation = ++containerGeneration.current;
    try {
      const result = await invoke<Container[]>("list_containers", {
        profile: name,
      });
      if (
        generation !== containerGeneration.current ||
        selectedRef.current !== name
      )
        return;
      setContainers(result);
      setContainerError("");
    } catch (cause) {
      if (
        generation !== containerGeneration.current ||
        selectedRef.current !== name
      )
        return;
      setContainers([]);
      setContainerError(errorText(cause));
    }
  }, []);

  useEffect(() => {
    void Promise.all([
      refreshProfiles(),
      invoke<Environment>("environment").then(setEnvironment),
    ])
      .catch((cause) => setError(errorText(cause)))
      .finally(() => setLoading(false));
    const timer = setInterval(() => {
      if (!busyRef.current)
        void refreshProfiles().catch((cause) => setError(errorText(cause)));
    }, 5000);
    return () => clearInterval(timer);
  }, [refreshProfiles]);

  useEffect(() => {
    setContainers([]);
    setContainerError("");
    ++containerGeneration.current;
  }, [selected, running, docker]);

  useEffect(() => {
    if (!running || !docker || busy) return;
    void refreshContainers(selected);
    const timer = setInterval(() => {
      if (!busyRef.current) void refreshContainers(selected);
    }, 5000);
    return () => {
      clearInterval(timer);
      ++containerGeneration.current;
    };
  }, [selected, running, docker, busy, refreshContainers]);

  useEffect(() => {
    if (!busy) return;
    setElapsed(0);
    const timer = setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  async function refresh() {
    setRefreshing(true);
    try {
      const result = await refreshProfiles();
      const current = result.find((item) => item.name === selected);
      if (current?.status === "Running" && current.runtime.startsWith("docker"))
        await refreshContainers(selected);
      setEnvironment(await invoke<Environment>("environment"));
      setError("");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setRefreshing(false);
    }
  }

  async function operate(
    title: string,
    work: () => Promise<OperationResult>,
    preferred?: string,
  ) {
    if (busyRef.current) return;
    busyRef.current = true;
    ++containerGeneration.current;
    setBusy(title);
    setModal(null);
    setError("");
    setSuccess("");
    try {
      const result = await work();
      setModal(null);
      setSuccess(result.message);
      setActivity((items) =>
        [
          {
            title,
            output: result.output || result.message,
            time: new Date().toLocaleTimeString("ja-JP"),
            failed: false,
          },
          ...items,
        ].slice(0, 12),
      );
      const updated = await refreshProfiles(preferred);
      const current = updated.find(
        (item) => item.name === (preferred ?? selected),
      );
      if (current?.status === "Running" && current.runtime.startsWith("docker"))
        await refreshContainers(current.name);
    } catch (cause) {
      const text = errorText(cause);
      setSuccess("");
      setError(text);
      setActivity((items) =>
        [
          {
            title,
            output: text,
            time: new Date().toLocaleTimeString("ja-JP"),
            failed: true,
          },
          ...items,
        ].slice(0, 12),
      );
      await refreshProfiles().catch(() => undefined);
    } finally {
      busyRef.current = false;
      setBusy("");
    }
  }

  function profileAction(
    action: ProfileAction,
    name = selected,
    resources?: Resources,
    deleteData = false,
  ) {
    const titles: Record<ProfileAction, string> = {
      create: "プロファイルを作成",
      start: "プロファイルを起動",
      stop: "プロファイルを停止",
      restart: "プロファイルを再起動",
      configure: "リソース設定を適用",
      delete: "プロファイルを削除",
    };
    return operate(
      titles[action],
      () =>
        invoke("mutate_profile", {
          request: { action, profile: name, resources, deleteData },
        }),
      action === "delete" ? undefined : name,
    );
  }

  async function showLogs(container: Container, name = selected) {
    setLogs({ profile: name, container, text: "", loading: true });
    try {
      const text = await invoke<string>("container_logs", {
        profile: name,
        id: container.id,
      });
      setLogs((current) =>
        current?.container.id === container.id && current.profile === name
          ? { ...current, text, loading: false }
          : current,
      );
    } catch (cause) {
      setLogs((current) =>
        current?.container.id === container.id && current.profile === name
          ? { ...current, text: errorText(cause), loading: false }
          : current,
      );
    }
  }

  const visibleContainers = containers.filter((item) =>
    `${item.name} ${item.image} ${item.id}`
      .toLowerCase()
      .includes(filter.toLowerCase()),
  );
  const closeModal = () => {
    if (!busyRef.current) setModal(null);
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <Icon name="cube" size={26} />
          </span>
          <div>
            colima<span>DESKTOP</span>
          </div>
        </div>
        <div className="sidebar-label">
          WORKSPACE <span>LOCAL</span>
        </div>
        <div className="sidebar-heading">
          <span>プロファイル</span>
          <span className="count">{profiles.length}</span>
        </div>
        <nav aria-label="プロファイル" className="profile-nav">
          {profiles.map((item) => (
            <button
              key={item.name}
              data-testid={`profile-${item.name}`}
              className={`profile-link ${selected === item.name ? "selected" : ""}`}
              disabled={!!busy}
              onClick={() => {
                setSelected(item.name);
                setFilter("");
              }}
            >
              <span
                className={`dot ${item.status === "Running" ? "online" : ""}`}
              />
              <span className="profile-link-name">{item.name}</span>
              {selected === item.name && <Icon name="arrow" size={15} />}
            </button>
          ))}
          {!profiles.length && (
            <p className="sidebar-empty">
              {loading ? "読み込み中…" : "プロファイルがありません"}
            </p>
          )}
        </nav>
        <button
          className="new-profile"
          data-testid="new-profile"
          disabled={!!busy || loading}
          onClick={() => setModal({ type: "create" })}
        >
          <Icon name="plus" size={17} />
          新規プロファイル
        </button>
        <div className="sidebar-footer">
          <span className={`dot ${environment ? "online" : ""}`} />
          <div>
            {environment
              ? `Colima ${environment.colimaVersion}`
              : "Colima に接続待機中"}
            <small>ローカル環境 · Tauri 2</small>
          </div>
        </div>
      </aside>

      <main>
        <header className="topbar">
          <div className="breadcrumb">
            ワークスペース <span>/</span>
            <strong>概要</strong>
          </div>
          <div className="topbar-right">
            <span className="local-tag">
              <span className={`dot ${environment ? "online" : ""}`} />
              {environment ? "ローカル接続" : "接続を確認中"}
            </span>
            <button
              className="icon-button"
              data-testid="refresh"
              aria-label="最新の状態に更新"
              title="最新の状態に更新"
              disabled={!!busy || refreshing}
              onClick={() => void refresh()}
            >
              <Icon name="refresh" />
            </button>
          </div>
        </header>
        <div className="main-content">
          <div className="page-heading">
            <div className="eyebrow">PROFILE OVERVIEW</div>
            <div className="title-line">
              <h1 data-testid="selected-profile">
                {profile?.name ?? "Colima ワークスペース"}
              </h1>
              {profile && (
                <span
                  className={`status-badge ${running ? "running" : ""}`}
                  data-testid="profile-status"
                >
                  <span className={`dot ${running ? "online" : ""}`} />
                  {profile.status}
                </span>
              )}
            </div>
            <p className="muted">仮想マシンとコンテナを、ひとつの場所で。</p>
          </div>
          <div aria-live="polite">
            {!!busy && (
              <div className="banner progress" data-testid="operation-progress">
                <span className="spinner" />
                <div>
                  <strong>{busy}中…</strong>
                  <span>
                    実際の状態を確認してから完了します。{elapsed} 秒経過
                  </span>
                </div>
              </div>
            )}
            {!!error && (
              <div
                className="banner error"
                role="alert"
                data-testid="operation-error"
              >
                <div>
                  <strong>操作を完了できませんでした</strong>
                  <pre>{error}</pre>
                </div>
                <button
                  className="icon-button"
                  onClick={() => setError("")}
                  aria-label="エラーを閉じる"
                >
                  <Icon name="close" />
                </button>
              </div>
            )}
            {!!success && !busy && (
              <div className="banner success" data-testid="operation-success">
                <Icon name="check" />
                <span>{success}</span>
                <button
                  className="icon-button"
                  onClick={() => setSuccess("")}
                  aria-label="通知を閉じる"
                >
                  <Icon name="close" />
                </button>
              </div>
            )}
          </div>

          {profile ? (
            <>
              <section className="machine-card" aria-label="プロファイル操作">
                <div className="machine-icon">
                  <Icon name="cube" size={30} />
                </div>
                <div className="machine-info">
                  <h2>Colima 仮想マシン</h2>
                  <div className="machine-meta">
                    <span>{profile.runtime || "—"}</span>
                    <span>{profile.arch || "—"}</span>
                    <span>
                      {running
                        ? "稼働中"
                        : stopped
                          ? "停止中"
                          : "状態を確認してください"}
                    </span>
                  </div>
                </div>
                <div className="machine-actions">
                  <button
                    data-testid="profile-restart"
                    disabled={!running || !!busy}
                    onClick={() => void profileAction("restart")}
                  >
                    <Icon name="refresh" size={16} />
                    再起動
                  </button>
                  {running ? (
                    <button
                      data-testid="profile-stop"
                      disabled={!!busy}
                      onClick={() => void profileAction("stop")}
                    >
                      <Icon name="stop" size={16} />
                      停止
                    </button>
                  ) : (
                    <button
                      className="primary"
                      data-testid="profile-start"
                      disabled={!stopped || !!busy}
                      onClick={() => void profileAction("start")}
                    >
                      <Icon name="play" size={16} />
                      起動
                    </button>
                  )}
                </div>
              </section>
              <section className="resource-section" aria-label="リソース">
                <div className="section-heading">
                  <h2>リソース</h2>
                  <button
                    className="text-button"
                    data-testid="profile-settings"
                    disabled={!stopped || !!busy}
                    title={
                      stopped
                        ? "設定を変更"
                        : "設定を変更するには停止してください"
                    }
                    onClick={() => setModal({ type: "configure", profile })}
                  >
                    <Icon name="settings" size={15} />
                    設定を変更
                  </button>
                </div>
                <div className="resource-grid">
                  {[
                    {
                      title: "CPU",
                      value: profile.cpus || "—",
                      unit: "コア",
                      icon: "cpu",
                      detail: "仮想 CPU",
                    },
                    {
                      title: "メモリ",
                      value: gib(profile.memory) || "—",
                      unit: "GiB",
                      icon: "memory",
                      detail: "割り当て容量",
                    },
                    {
                      title: "ディスク",
                      value: gib(profile.disk) || "—",
                      unit: "GiB",
                      icon: "disk",
                      detail: "最大容量",
                    },
                  ].map((item) => (
                    <div className="resource-card" key={item.title}>
                      <div className="resource-label">
                        <span>{item.title}</span>
                        <Icon name={item.icon} size={20} />
                      </div>
                      <div className="resource-value">
                        {item.value}
                        <span>{item.unit}</span>
                      </div>
                      <div className="resource-track">
                        <span />
                      </div>
                      <small>{item.detail}</small>
                    </div>
                  ))}
                </div>
                {running && (
                  <p className="resource-note">
                    リソースの設定は、プロファイルを停止すると変更できます。
                  </p>
                )}
              </section>
              <section className="containers-section" aria-label="コンテナ">
                <div className="section-heading">
                  <div className="heading-with-count">
                    <h2>コンテナ</h2>
                    <span className="light-count">{containers.length}</span>
                  </div>
                  <label className="search">
                    <Icon name="search" size={15} />
                    <input
                      aria-label="コンテナを検索"
                      placeholder="名前・イメージで検索"
                      value={filter}
                      onChange={(event) => setFilter(event.target.value)}
                    />
                  </label>
                </div>
                <div className="table-card">
                  {!running ? (
                    <div className="empty-state">
                      <Icon name="cube" size={32} />
                      <h3>プロファイルは停止中です</h3>
                      <p>起動するとコンテナを確認・操作できます。</p>
                    </div>
                  ) : !docker ? (
                    <div className="empty-state">
                      <Icon name="cube" size={32} />
                      <h3>{profile.runtime} ランタイム</h3>
                      <p>
                        コンテナの操作は Docker ランタイムに対応しています。
                      </p>
                    </div>
                  ) : containerError ? (
                    <div className="empty-state error-text" role="alert">
                      <h3>コンテナを取得できませんでした</h3>
                      <pre>{containerError}</pre>
                    </div>
                  ) : !containers.length ? (
                    <div className="empty-state">
                      <Icon name="cube" size={32} />
                      <h3>コンテナがありません</h3>
                      <p>
                        このプロファイルに作成したコンテナがここに表示されます。
                      </p>
                    </div>
                  ) : (
                    <table>
                      <thead>
                        <tr>
                          <th>名前 / イメージ</th>
                          <th>状態</th>
                          <th>ポート</th>
                          <th className="align-right">操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleContainers.map((container) => (
                          <tr
                            key={container.id}
                            data-testid={`container-${container.id}`}
                          >
                            <td>
                              <div className="container-name">
                                <Icon name="cube" size={17} />
                                <strong>{container.name}</strong>
                              </div>
                              <span
                                className="image-name"
                                title={container.image}
                              >
                                {container.image}
                              </span>
                            </td>
                            <td>
                              <span
                                className={`container-status ${container.state === "running" ? "running" : ""}`}
                                data-testid="container-state"
                              >
                                <span
                                  className={`dot ${container.state === "running" ? "online" : ""}`}
                                />
                                {container.state}
                              </span>
                              <small className="container-detail">
                                {container.status}
                              </small>
                            </td>
                            <td>
                              <span className="ports">
                                {container.ports || "—"}
                              </span>
                            </td>
                            <td>
                              <div className="row-actions">
                                <button
                                  className="icon-button"
                                  data-testid="container-logs"
                                  aria-label={`${container.name} のログ`}
                                  title="ログを表示"
                                  disabled={!!busy}
                                  onClick={() => void showLogs(container)}
                                >
                                  <Icon name="terminal" size={17} />
                                </button>
                                {container.state === "running" ? (
                                  <button
                                    className="icon-button"
                                    data-testid="container-stop"
                                    aria-label={`${container.name} を停止`}
                                    title="停止"
                                    disabled={!!busy}
                                    onClick={() =>
                                      void operate("コンテナを停止", () =>
                                        invoke("mutate_container", {
                                          request: {
                                            profile: selected,
                                            id: container.id,
                                            action: "stop",
                                          },
                                        }),
                                      )
                                    }
                                  >
                                    <Icon name="stop" size={16} />
                                  </button>
                                ) : (
                                  <button
                                    className="icon-button"
                                    data-testid="container-start"
                                    aria-label={`${container.name} を起動`}
                                    title="起動"
                                    disabled={
                                      !!busy ||
                                      !["exited", "created"].includes(
                                        container.state,
                                      )
                                    }
                                    onClick={() =>
                                      void operate("コンテナを起動", () =>
                                        invoke("mutate_container", {
                                          request: {
                                            profile: selected,
                                            id: container.id,
                                            action: "start",
                                          },
                                        }),
                                      )
                                    }
                                  >
                                    <Icon name="play" size={17} />
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  {!!containers.length && !visibleContainers.length && (
                    <div className="no-results">
                      一致するコンテナがありません。
                    </div>
                  )}
                </div>
              </section>
              <div className="profile-footer">
                <span>状態は 5 秒ごとに自動更新されます</span>
                <button
                  className="text-button delete-button"
                  data-testid="profile-delete"
                  title={
                    stopped
                      ? "プロファイルを削除"
                      : "削除するには停止してください"
                  }
                  disabled={!stopped || !!busy}
                  onClick={() => setModal({ type: "delete", profile })}
                >
                  <Icon name="trash" size={15} />
                  プロファイルを削除
                </button>
              </div>
            </>
          ) : (
            <section className="welcome-card">
              <div className="welcome-icon">
                <Icon name="cube" size={48} />
              </div>
              <h2>
                {loading
                  ? "Colima に接続しています"
                  : "最初の環境をつくりましょう"}
              </h2>
              <p>
                {loading
                  ? "プロファイルの状態を確認しています。"
                  : "用途に合わせたプロファイルを作成して、コンテナを管理できます。"}
              </p>
              {!loading && (
                <button
                  className="primary"
                  disabled={!!busy}
                  onClick={() => setModal({ type: "create" })}
                >
                  <Icon name="plus" />
                  プロファイルを作成
                </button>
              )}
            </section>
          )}
          {!!activity.length && (
            <section className="activity-section">
              <div className="section-heading">
                <h2>最近の操作</h2>
                <span className="muted">このセッション</span>
              </div>
              {activity.map((item, index) => (
                <details
                  key={`${item.time}-${index}`}
                  className={item.failed ? "activity failed" : "activity"}
                >
                  <summary>
                    <span
                      className={`dot ${item.failed ? "offline" : "online"}`}
                    />
                    <span>{item.title}</span>
                    <small>{item.failed ? "失敗" : "完了"}</small>
                    <time>{item.time}</time>
                  </summary>
                  <pre>{item.output}</pre>
                </details>
              ))}
            </section>
          )}
        </div>
        <footer className="app-footer">
          <span>Colima GUI</span>
          <span>
            {environment?.dockerVersion ?? "Docker CLI を確認してください"}
          </span>
        </footer>
      </main>
      {modal?.type === "delete" ? (
        <DeleteForm
          profile={modal.profile}
          busy={!!busy}
          onClose={closeModal}
          onSubmit={(deleteData) =>
            void profileAction(
              "delete",
              modal.profile.name,
              undefined,
              deleteData,
            )
          }
        />
      ) : (
        modal && (
          <ProfileForm
            modal={modal}
            busy={!!busy}
            onClose={closeModal}
            onSubmit={(name, resources) =>
              void profileAction(modal.type, name, resources)
            }
          />
        )
      )}
      {logs && (
        <Dialog
          title={`${logs.container.name} のログ`}
          wide
          onClose={() => setLogs(null)}
        >
          <div className="log-heading">
            <span>
              {logs.profile} / {logs.container.id.slice(0, 12)}
            </span>
            <span>末尾 200 行</span>
          </div>
          <pre className="log-output" data-testid="container-log-output">
            {logs.loading
              ? "ログを読み込んでいます…"
              : logs.text || "ログはまだありません。"}
          </pre>
          <div className="dialog-actions">
            <button
              onClick={() => void showLogs(logs.container, logs.profile)}
              disabled={logs.loading}
            >
              <Icon name="refresh" size={16} />
              ログを更新
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
