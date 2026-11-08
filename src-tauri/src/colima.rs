use serde::{Deserialize, Serialize};
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

const GIB: u64 = 1_073_741_824;
const QUERY_TIMEOUT: Duration = Duration::from_secs(20);
const LIFECYCLE_TIMEOUT: Duration = Duration::from_secs(600);
const MAX_OUTPUT: usize = 2 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub name: String,
    pub status: String,
    #[serde(default)]
    pub arch: String,
    #[serde(default)]
    pub cpus: u32,
    #[serde(default)]
    pub memory: u64,
    #[serde(default)]
    pub disk: u64,
    #[serde(default)]
    pub runtime: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    pub colima_version: String,
    pub docker_version: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Resources {
    pub cpus: u32,
    pub memory_gi_b: u32,
    pub disk_gi_b: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProfileAction {
    Create,
    Start,
    Stop,
    Restart,
    Delete,
    Configure,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileRequest {
    pub action: ProfileAction,
    pub profile: String,
    pub resources: Option<Resources>,
    #[serde(default)]
    pub delete_data: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationResult {
    pub message: String,
    pub output: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Container {
    pub id: String,
    pub name: String,
    pub image: String,
    pub state: String,
    pub status: String,
    pub ports: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ContainerAction {
    Start,
    Stop,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerRequest {
    pub profile: String,
    pub id: String,
    pub action: ContainerAction,
}

#[derive(Deserialize)]
struct DockerRow {
    #[serde(rename = "ID")]
    id: String,
    #[serde(rename = "Names")]
    name: String,
    #[serde(rename = "Image")]
    image: String,
    #[serde(rename = "State")]
    state: String,
    #[serde(rename = "Status")]
    status: String,
    #[serde(rename = "Ports", default)]
    ports: String,
}

#[derive(Deserialize)]
struct Status {
    runtime: String,
    #[serde(default)]
    docker_socket: String,
}

struct Output {
    success: bool,
    stdout: String,
    stderr: String,
}

impl Output {
    fn text(&self) -> String {
        [self.stdout.trim(), self.stderr.trim()]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn checked(self, program: &str) -> Result<Self, String> {
        if self.success {
            return Ok(self);
        }
        Err(format!("{program} の実行に失敗しました。\n{}", self.text()))
    }
}

trait Runner {
    fn execute(&self, program: &str, args: &[String], timeout: Duration) -> Result<Output, String>;
}

struct ProcessRunner;

fn drain(reader: impl Read + Send + 'static) -> mpsc::Receiver<Result<String, String>> {
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let mut reader = reader;
        let mut captured = Vec::new();
        let mut buffer = [0; 8192];
        let mut exceeded = false;
        let result = loop {
            match reader.read(&mut buffer) {
                Ok(0) => {
                    break if exceeded {
                        Err("CLI の出力が 2 MiB を超えました。".to_string())
                    } else {
                        Ok(String::from_utf8_lossy(&captured).into_owned())
                    };
                }
                Ok(count) => {
                    let remaining = MAX_OUTPUT.saturating_sub(captured.len());
                    captured.extend_from_slice(&buffer[..count.min(remaining)]);
                    exceeded |= count > remaining;
                }
                Err(error) => break Err(format!("CLI の出力を読み取れません: {error}")),
            }
        };
        let _ = sender.send(result);
    });
    receiver
}

fn cli_path() -> Result<std::ffi::OsString, String> {
    let inherited = std::env::var_os("PATH").unwrap_or_default();
    let paths = std::env::split_paths(&inherited).chain(
        [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/opt/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ]
        .into_iter()
        .map(std::path::PathBuf::from),
    );
    std::env::join_paths(paths).map_err(|error| format!("PATH を構成できません: {error}"))
}

impl Runner for ProcessRunner {
    fn execute(&self, program: &str, args: &[String], timeout: Duration) -> Result<Output, String> {
        let mut command = Command::new(program);
        command
            .args(args)
            .env("PATH", cli_path()?)
            .env("NO_COLOR", "1")
            .env("TERM", "dumb")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if program == "docker" {
            for variable in [
                "DOCKER_HOST",
                "DOCKER_CONTEXT",
                "DOCKER_TLS",
                "DOCKER_TLS_VERIFY",
                "DOCKER_CERT_PATH",
            ] {
                command.env_remove(variable);
            }
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command.spawn().map_err(|error| {
            format!("{program} を起動できません。インストールと PATH を確認してください。\n{error}")
        })?;
        let stdout = drain(child.stdout.take().ok_or("標準出力を取得できません。")?);
        let stderr = drain(
            child
                .stderr
                .take()
                .ok_or("標準エラー出力を取得できません。")?,
        );
        let started = Instant::now();
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if started.elapsed() < timeout => thread::sleep(Duration::from_millis(40)),
                Ok(None) => {
                    #[cfg(unix)]
                    unsafe {
                        // Killing only Colima can leave its SSH child holding the output pipes open.
                        libc::kill(-(child.id() as i32), libc::SIGKILL);
                    }
                    let _ = child.kill();
                    let _ = child.wait();
                    let detail = stderr
                        .recv_timeout(Duration::from_secs(1))
                        .ok()
                        .and_then(Result::ok)
                        .unwrap_or_default();
                    return Err(format!(
                        "{program} が {} 秒以内に完了しませんでした。状態を更新して確認してください。\n{detail}",
                        timeout.as_secs()
                    ));
                }
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("{program} の終了状態を取得できません: {error}"));
                }
            }
        };
        let receive = |receiver: mpsc::Receiver<Result<String, String>>| {
            receiver
                .recv_timeout(Duration::from_secs(2))
                .map_err(|_| "CLI の出力が閉じられませんでした。".to_string())?
        };
        Ok(Output {
            success: status.success(),
            stdout: receive(stdout)?,
            stderr: receive(stderr)?,
        })
    }
}

struct Backend<R>(R);

fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_string()).collect()
}

fn validate_profile(name: &str, new: bool) -> Result<(), String> {
    if name == "colima" || name.starts_with("colima-") {
        return Err("colima と colima- で始まる名前は Colima の予約名です。別のプロファイル名を指定してください。".into());
    }
    let mut bytes = name.bytes();
    let first = bytes.next();
    let valid = if new {
        name.len() <= 40
            && first.is_some_and(|byte| byte.is_ascii_lowercase())
            && bytes.all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    } else {
        name.len() <= 128
            && first.is_some_and(|byte| byte.is_ascii_alphanumeric())
            && !name.contains("..")
            && bytes.all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
    };
    if valid {
        return Ok(());
    }
    Err("プロファイル名が不正です。新規作成には英小文字で始まる英小文字・数字・ハイフンを 40 文字以内で指定してください。".into())
}

fn validate_id(id: &str) -> Result<(), String> {
    if (12..=64).contains(&id.len()) && id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Ok(());
    }
    Err("コンテナ ID が不正です。".into())
}

fn validate_resources(resources: &Resources, current: Option<&Profile>) -> Result<(), String> {
    if !(1..=128).contains(&resources.cpus)
        || !(1..=256).contains(&resources.memory_gi_b)
        || !(5..=2048).contains(&resources.disk_gi_b)
    {
        return Err(
            "CPU は 1〜128、メモリは 1〜256 GiB、ディスクは 5〜2048 GiB で指定してください。"
                .into(),
        );
    }
    if current.is_some_and(|profile| u64::from(resources.disk_gi_b) * GIB < profile.disk) {
        return Err("ディスクは縮小できません。現在の容量以上を指定してください。".into());
    }
    Ok(())
}

fn parse_profiles(value: &str) -> Result<Vec<Profile>, String> {
    let mut profiles = value
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            serde_json::from_str::<Profile>(line)
                .map_err(|error| format!("Colima のプロファイル一覧を解析できません: {error}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    profiles.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(profiles)
}

fn ensure_stopped(profile: &Profile) -> Result<(), String> {
    if profile.status == "Stopped" {
        return Ok(());
    }
    Err(format!(
        "{} は {} です。停止してから操作してください。",
        profile.name, profile.status
    ))
}

impl<R: Runner> Backend<R> {
    fn execute(
        &self,
        program: &str,
        arguments: &[String],
        timeout: Duration,
    ) -> Result<Output, String> {
        self.0
            .execute(program, arguments, timeout)?
            .checked(program)
    }

    fn profiles(&self) -> Result<Vec<Profile>, String> {
        parse_profiles(
            &self
                .execute("colima", &args(&["list", "--json"]), QUERY_TIMEOUT)?
                .stdout,
        )
    }

    fn profile(&self, name: &str) -> Result<Profile, String> {
        self.profiles()?
            .into_iter()
            .find(|profile| profile.name == name)
            .ok_or_else(|| format!("プロファイル {name} が見つかりません。"))
    }

    fn socket(&self, name: &str) -> Result<String, String> {
        validate_profile(name, false)?;
        let value = self.execute(
            "colima",
            &args(&["status", "--profile", name, "--json"]),
            QUERY_TIMEOUT,
        )?;
        let status: Status = serde_json::from_str(&value.stdout)
            .map_err(|error| format!("Colima の状態を解析できません: {error}"))?;
        if !status.runtime.split('+').any(|runtime| runtime == "docker") {
            return Err("コンテナ管理には Docker ランタイムのプロファイルが必要です。".into());
        }
        if !status.docker_socket.starts_with("unix:///") {
            return Err("Colima が有効なローカル Docker ソケットを返しませんでした。".into());
        }
        Ok(status.docker_socket)
    }

    fn docker(
        &self,
        socket: &str,
        arguments: &[&str],
        timeout: Duration,
    ) -> Result<Output, String> {
        self.execute(
            "docker",
            &args(&["--host", socket])
                .into_iter()
                .chain(args(arguments))
                .collect::<Vec<_>>(),
            timeout,
        )
    }

    fn ready(&self, profile: &Profile) -> Result<(), String> {
        if !profile
            .runtime
            .split('+')
            .any(|runtime| runtime == "docker")
        {
            return Ok(());
        }
        let socket = self.socket(&profile.name)?;
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            let result = self.docker(
                &socket,
                &["info", "--format", "{{.ServerVersion}}"],
                Duration::from_secs(10),
            );
            if result.is_ok() {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(format!(
                    "VM は起動しましたが Docker が準備完了しませんでした。\n{}",
                    result.err().unwrap_or_default()
                ));
            }
            thread::sleep(Duration::from_secs(1));
        }
    }

    fn verify_running(&self, name: &str, resources: Option<&Resources>) -> Result<(), String> {
        let profile = self.profile(name)?;
        if profile.status != "Running" {
            return Err(format!(
                "操作後の状態が Running ではありません: {}",
                profile.status
            ));
        }
        if resources.is_some_and(|resources| {
            profile.cpus != resources.cpus
                || profile.memory != u64::from(resources.memory_gi_b) * GIB
                || profile.disk < u64::from(resources.disk_gi_b) * GIB
        }) {
            return Err("指定した CPU・メモリ・ディスクが反映されていません。状態を更新して確認してください。".into());
        }
        self.ready(&profile)
    }

    fn start(
        &self,
        name: &str,
        resources: Option<&Resources>,
        create: bool,
    ) -> Result<Output, String> {
        let mut arguments = args(&["start", "--profile", name, "--activate=false"]);
        if create {
            arguments.extend(args(&[
                "--runtime",
                "docker",
                "--template=false",
                "--ssh-config=false",
            ]));
        }
        if let Some(resources) = resources {
            arguments.extend(args(&[
                "--cpus",
                &resources.cpus.to_string(),
                "--memory",
                &resources.memory_gi_b.to_string(),
                "--disk",
                &resources.disk_gi_b.to_string(),
            ]));
        }
        self.execute("colima", &arguments, LIFECYCLE_TIMEOUT)
    }

    fn stop(&self, name: &str) -> Result<Output, String> {
        let output = self.execute(
            "colima",
            &args(&["stop", "--profile", name]),
            LIFECYCLE_TIMEOUT,
        )?;
        ensure_stopped(&self.profile(name)?)?;
        Ok(output)
    }

    fn mutate_profile(&self, request: ProfileRequest) -> Result<OperationResult, String> {
        validate_profile(
            &request.profile,
            matches!(request.action, ProfileAction::Create),
        )?;
        let name = request.profile.as_str();
        let profiles = self.profiles()?;
        let current = profiles.iter().find(|profile| profile.name == name);
        let (message, output) = match request.action {
            ProfileAction::Create => {
                if current.is_some() {
                    return Err(format!("プロファイル {name} は既に存在します。"));
                }
                let resources = request
                    .resources
                    .as_ref()
                    .ok_or("リソース設定が必要です。")?;
                validate_resources(resources, None)?;
                let output = self.start(name, Some(resources), true)?;
                self.verify_running(name, Some(resources))?;
                (format!("{name} を作成して起動しました。"), output.text())
            }
            ProfileAction::Start => {
                let profile =
                    current.ok_or_else(|| format!("プロファイル {name} が見つかりません。"))?;
                if request.resources.is_some() {
                    return Err("設定変更には設定を適用して起動を使用してください。".into());
                }
                if profile.status != "Running" {
                    ensure_stopped(profile)?;
                }
                let output = self.start(name, None, false)?;
                self.verify_running(name, None)?;
                (format!("{name} を起動しました。"), output.text())
            }
            ProfileAction::Stop => {
                current.ok_or_else(|| format!("プロファイル {name} が見つかりません。"))?;
                let output = self.stop(name)?;
                (format!("{name} を停止しました。"), output.text())
            }
            ProfileAction::Restart => {
                let profile =
                    current.ok_or_else(|| format!("プロファイル {name} が見つかりません。"))?;
                if profile.status != "Running" {
                    return Err("再起動には起動中のプロファイルを選択してください。".into());
                }
                let stopped = self.stop(name)?;
                let started = self.start(name, None, false)?;
                self.verify_running(name, None)?;
                (
                    format!("{name} を再起動しました。"),
                    format!("{}\n{}", stopped.text(), started.text()),
                )
            }
            ProfileAction::Configure => {
                let profile =
                    current.ok_or_else(|| format!("プロファイル {name} が見つかりません。"))?;
                ensure_stopped(profile)?;
                let resources = request
                    .resources
                    .as_ref()
                    .ok_or("リソース設定が必要です。")?;
                validate_resources(resources, Some(profile))?;
                let output = self.start(name, Some(resources), false)?;
                self.verify_running(name, Some(resources))?;
                (
                    format!("{name} の設定を適用して起動しました。"),
                    output.text(),
                )
            }
            ProfileAction::Delete => {
                ensure_stopped(
                    current.ok_or_else(|| format!("プロファイル {name} が見つかりません。"))?,
                )?;
                let mut arguments = args(&["delete", "--profile", name, "--force"]);
                if request.delete_data {
                    arguments.push("--data".into());
                }
                let output = self.execute("colima", &arguments, LIFECYCLE_TIMEOUT)?;
                if self.profiles()?.iter().any(|profile| profile.name == name) {
                    return Err(
                        "削除後もプロファイルが存在します。状態を更新して確認してください。".into(),
                    );
                }
                (format!("{name} を削除しました。"), output.text())
            }
        };
        Ok(OperationResult { message, output })
    }

    fn containers(&self, name: &str) -> Result<Vec<Container>, String> {
        let socket = self.socket(name)?;
        let output = self.docker(
            &socket,
            &["ps", "--all", "--no-trunc", "--format", "{{json .}}"],
            QUERY_TIMEOUT,
        )?;
        output
            .stdout
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| {
                let row: DockerRow = serde_json::from_str(line)
                    .map_err(|error| format!("コンテナ一覧を解析できません: {error}"))?;
                Ok(Container {
                    id: row.id,
                    name: row.name,
                    image: row.image,
                    state: row.state,
                    status: row.status,
                    ports: row.ports,
                })
            })
            .collect()
    }

    fn mutate_container(&self, request: ContainerRequest) -> Result<OperationResult, String> {
        validate_id(&request.id)?;
        let socket = self.socket(&request.profile)?;
        let (action, expected, message) = match request.action {
            ContainerAction::Start => ("start", "running", "起動"),
            ContainerAction::Stop => ("stop", "exited", "停止"),
        };
        let output = self.docker(&socket, &[action, &request.id], Duration::from_secs(90))?;
        let state = self.docker(
            &socket,
            &[
                "inspect",
                "--type",
                "container",
                "--format",
                "{{.State.Status}}",
                &request.id,
            ],
            QUERY_TIMEOUT,
        )?;
        if state.stdout.trim() != expected {
            return Err(format!(
                "コンテナの状態が {expected} になりませんでした: {}",
                state.stdout.trim()
            ));
        }
        Ok(OperationResult {
            message: format!("コンテナを{message}しました。"),
            output: output.text(),
        })
    }

    fn logs(&self, profile: &str, id: &str) -> Result<String, String> {
        validate_id(id)?;
        let socket = self.socket(profile)?;
        Ok(self
            .docker(
                &socket,
                &["logs", "--tail", "200", "--timestamps", id],
                QUERY_TIMEOUT,
            )?
            .text())
    }
}

pub fn environment() -> Result<Environment, String> {
    let runner = ProcessRunner;
    let output = runner
        .execute("colima", &args(&["version"]), QUERY_TIMEOUT)?
        .checked("colima")?;
    let version = output.stdout.lines().next().unwrap_or_default().trim();
    let docker_version = runner
        .execute("docker", &args(&["--version"]), QUERY_TIMEOUT)
        .ok()
        .filter(|output| output.success)
        .map(|output| output.stdout.trim().to_string());
    Ok(Environment {
        colima_version: version
            .strip_prefix("colima version ")
            .unwrap_or(version)
            .to_string(),
        docker_version,
    })
}

pub fn list_profiles() -> Result<Vec<Profile>, String> {
    Backend(ProcessRunner).profiles()
}
pub fn mutate_profile(request: ProfileRequest) -> Result<OperationResult, String> {
    Backend(ProcessRunner).mutate_profile(request)
}
pub fn list_containers(profile: String) -> Result<Vec<Container>, String> {
    Backend(ProcessRunner).containers(&profile)
}
pub fn mutate_container(request: ContainerRequest) -> Result<OperationResult, String> {
    Backend(ProcessRunner).mutate_container(request)
}
pub fn container_logs(profile: String, id: String) -> Result<String, String> {
    Backend(ProcessRunner).logs(&profile, &id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::Mutex;

    struct Expected {
        program: &'static str,
        args: Vec<String>,
        success: bool,
        stdout: String,
        stderr: String,
    }

    struct FakeRunner(Mutex<VecDeque<Expected>>);

    impl Runner for FakeRunner {
        fn execute(&self, program: &str, args: &[String], _: Duration) -> Result<Output, String> {
            let expected = self
                .0
                .lock()
                .unwrap()
                .pop_front()
                .expect("unexpected command");
            assert_eq!(program, expected.program);
            assert_eq!(args, expected.args);
            Ok(Output {
                success: expected.success,
                stdout: expected.stdout,
                stderr: expected.stderr,
            })
        }
    }

    fn command(program: &'static str, arguments: &[&str], stdout: &str) -> Expected {
        Expected {
            program,
            args: args(arguments),
            success: true,
            stdout: stdout.into(),
            stderr: String::new(),
        }
    }

    fn profile_json(status: &str, cpus: u32) -> String {
        format!(
            r#"{{"name":"test","status":"{status}","arch":"aarch64","cpus":{cpus},"memory":2147483648,"disk":10737418240,"runtime":"docker"}}"#
        )
    }

    fn backend(expected: Vec<Expected>) -> Backend<FakeRunner> {
        Backend(FakeRunner(Mutex::new(expected.into())))
    }

    fn request(action: ProfileAction) -> ProfileRequest {
        ProfileRequest {
            action,
            profile: "test".into(),
            resources: None,
            delete_data: false,
        }
    }

    #[test]
    fn lists_ndjson_and_handles_empty_profiles() {
        let json = format!(
            "{}\n{}\n",
            profile_json("Running", 2),
            profile_json("Stopped", 2).replace("test", "another")
        );
        let profiles = parse_profiles(&json).unwrap();
        assert_eq!(profiles.len(), 2);
        assert_eq!(profiles[0].name, "another");
        assert_eq!(profiles[1].memory, 2 * GIB);
        assert!(parse_profiles("").unwrap().is_empty());
        assert!(parse_profiles("not-json").is_err());
    }

    #[test]
    fn rejects_path_traversal_options_and_invalid_resources() {
        for name in ["", "../default", "--profile", "a/b", "a..b", "a;touch x"] {
            assert!(validate_profile(name, false).is_err(), "{name}");
        }
        for name in ["default", "my-profile", "a1"] {
            validate_profile(name, true).unwrap();
        }
        assert!(validate_profile("Capital", true).is_err());
        assert!(validate_id("--help").is_err());
        assert!(validate_id("f".repeat(64).as_str()).is_ok());
        let current = parse_profiles(&profile_json("Stopped", 2))
            .unwrap()
            .remove(0);
        assert!(
            validate_resources(
                &Resources {
                    cpus: 2,
                    memory_gi_b: 2,
                    disk_gi_b: 9
                },
                Some(&current)
            )
            .is_err()
        );
        assert!(
            validate_resources(
                &Resources {
                    cpus: 0,
                    memory_gi_b: 2,
                    disk_gi_b: 10
                },
                None
            )
            .is_err()
        );
    }

    #[test]
    fn accepts_documented_frontend_resource_keys() {
        let request: ProfileRequest = serde_json::from_str(r#"{"action":"create","profile":"test","resources":{"cpus":2,"memoryGiB":2,"diskGiB":10}}"#).unwrap();
        assert_eq!(request.resources.unwrap().memory_gi_b, 2);
        assert!(!request.delete_data);
    }

    #[test]
    fn rejects_duplicate_creation_without_mutating_the_vm() {
        let backend = backend(vec![command(
            "colima",
            &["list", "--json"],
            &profile_json("Running", 2),
        )]);
        let error = backend
            .mutate_profile(request(ProfileAction::Create))
            .unwrap_err();
        assert!(error.contains("既に存在"));
        assert!(backend.0.0.lock().unwrap().is_empty());
    }

    #[test]
    fn rejects_colima_aliases_before_they_can_target_another_profile() {
        for name in ["colima", "colima-default", "colima-my-profile"] {
            let backend = backend(vec![]);
            let mut request = request(ProfileAction::Create);
            request.profile = name.into();
            assert!(
                backend
                    .mutate_profile(request)
                    .unwrap_err()
                    .contains("予約名")
            );
            assert!(validate_profile(name, false).is_err());
        }
        assert!(validate_profile("default", false).is_ok());
    }

    #[test]
    fn rejects_configuration_and_deletion_while_running() {
        for action in [ProfileAction::Configure, ProfileAction::Delete] {
            let backend = backend(vec![command(
                "colima",
                &["list", "--json"],
                &profile_json("Running", 2),
            )]);
            assert!(
                backend
                    .mutate_profile(request(action))
                    .unwrap_err()
                    .contains("停止して")
            );
        }
    }

    #[test]
    fn a_zero_exit_code_does_not_complete_a_stop_without_stopped_state() {
        let backend = backend(vec![
            command("colima", &["list", "--json"], &profile_json("Running", 2)),
            command("colima", &["stop", "--profile", "test"], "done"),
            command("colima", &["list", "--json"], &profile_json("Running", 2)),
        ]);
        assert!(
            backend
                .mutate_profile(request(ProfileAction::Stop))
                .is_err()
        );
    }

    #[test]
    fn completes_deletion_only_after_profile_disappears_and_honors_data_choice() {
        let backend = backend(vec![
            command("colima", &["list", "--json"], &profile_json("Stopped", 2)),
            command(
                "colima",
                &["delete", "--profile", "test", "--force", "--data"],
                "deleted",
            ),
            command("colima", &["list", "--json"], ""),
        ]);
        let mut request = request(ProfileAction::Delete);
        request.delete_data = true;
        assert!(
            backend
                .mutate_profile(request)
                .unwrap()
                .message
                .contains("削除しました")
        );
    }

    #[test]
    fn startup_checks_resources_and_docker_readiness_without_switching_context() {
        let backend = backend(vec![
            command("colima", &["list", "--json"], ""),
            command(
                "colima",
                &[
                    "start",
                    "--profile",
                    "test",
                    "--activate=false",
                    "--runtime",
                    "docker",
                    "--template=false",
                    "--ssh-config=false",
                    "--cpus",
                    "2",
                    "--memory",
                    "2",
                    "--disk",
                    "10",
                ],
                "started",
            ),
            command("colima", &["list", "--json"], &profile_json("Running", 2)),
            command(
                "colima",
                &["status", "--profile", "test", "--json"],
                r#"{"runtime":"docker","docker_socket":"unix:///tmp/test/docker.sock"}"#,
            ),
            command(
                "docker",
                &[
                    "--host",
                    "unix:///tmp/test/docker.sock",
                    "info",
                    "--format",
                    "{{.ServerVersion}}",
                ],
                "28.4.0",
            ),
        ]);
        let mut request = request(ProfileAction::Create);
        request.resources = Some(Resources {
            cpus: 2,
            memory_gi_b: 2,
            disk_gi_b: 10,
        });
        assert!(backend.mutate_profile(request).is_ok());
        assert!(backend.0.0.lock().unwrap().is_empty());
    }

    #[test]
    fn reports_missing_resource_application_instead_of_success() {
        let backend = backend(vec![command(
            "colima",
            &["list", "--json"],
            &profile_json("Running", 2),
        )]);
        let error = backend
            .verify_running(
                "test",
                Some(&Resources {
                    cpus: 3,
                    memory_gi_b: 2,
                    disk_gi_b: 10,
                }),
            )
            .unwrap_err();
        assert!(error.contains("反映されていません"));
    }

    #[test]
    fn container_start_requires_observed_running_state() {
        let id = "abcdef123456";
        let backend = backend(vec![
            command(
                "colima",
                &["status", "--profile", "test", "--json"],
                r#"{"runtime":"docker","docker_socket":"unix:///tmp/test/docker.sock"}"#,
            ),
            command(
                "docker",
                &["--host", "unix:///tmp/test/docker.sock", "start", id],
                id,
            ),
            command(
                "docker",
                &[
                    "--host",
                    "unix:///tmp/test/docker.sock",
                    "inspect",
                    "--type",
                    "container",
                    "--format",
                    "{{.State.Status}}",
                    id,
                ],
                "exited",
            ),
        ]);
        let error = backend
            .mutate_container(ContainerRequest {
                profile: "test".into(),
                id: id.into(),
                action: ContainerAction::Start,
            })
            .unwrap_err();
        assert!(error.contains("running になりません"));
    }

    #[test]
    fn includes_cli_error_output() {
        let backend = backend(vec![Expected {
            success: false,
            stderr: "permission denied".into(),
            ..command("colima", &["list", "--json"], "")
        }]);
        assert!(
            backend
                .profiles()
                .unwrap_err()
                .contains("permission denied")
        );
    }

    #[test]
    fn process_runner_times_out_and_reaps_child() {
        let started = Instant::now();
        let error = ProcessRunner
            .execute("/bin/sleep", &args(&["10"]), Duration::from_millis(80))
            .err()
            .unwrap();
        assert!(error.contains("以内に完了"));
        assert!(started.elapsed() < Duration::from_secs(3));
    }
}
