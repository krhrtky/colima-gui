# Colima GUI

Colima のプロファイルと Docker コンテナを操作する、日本語のデスクトップアプリです。Tauri 2、Rust、React、TypeScript、Vite で実装しています。

## 操作できること

| 対象 | 操作 |
| --- | --- |
| プロファイル | 一覧、作成して起動、起動、停止、再起動、削除 |
| リソース | CPU、メモリ、ディスク容量の表示・変更 |
| コンテナ | 一覧、起動、停止、ログ表示 |

新規プロファイルは Docker runtime で作成します。既存プロファイルも一覧に表示し、コンテナ管理は起動中の Docker プロファイルを対象にします。コンテナの作成・イメージ管理・Compose・Kubernetes の操作は対象外です。

新規プロファイル名は半角英小文字で始まる英小文字・数字・ハイフンの 40 文字以内です。Colima が別名として解釈する `colima` と `colima-` で始まる名前は、意図しないプロファイルへの操作を防ぐため本アプリでは入力を拒否します。同名のプロファイルがある場合も作成を拒否します。

リソースの変更はプロファイルを停止してから行い、設定を適用して起動します。ディスク容量は拡張のみ対応します。プロファイルの削除には停止と名前の再入力が必要です。コンテナデータは初期状態では保存し、削除画面で選択した場合だけ完全削除します。

## 開発環境

- macOS と仮想化が利用できる環境
- Xcode Command Line Tools
- Node.js 22.12 以上、npm
- Rust 1.97.1 と Cargo（`rust-toolchain.toml` で指定）
- Colima と Docker CLI（Colima 0.10.3 の CLI 仕様に合わせて実装）

```sh
xcode-select --install
brew install colima docker
npm install
npm run tauri dev
```

Colima と Docker CLI はアプリと別にインストールします。Finder からの起動でも Homebrew の実行ファイルを探せるように、バックエンドで検索パスを補います。

macOS 向けの Rust ビルドには、`.cargo/config.toml` で Xcode Command Line Tools の `/usr/bin/clang` を指定しています。別の C コンパイラが `PATH` に含まれていても、追加のリンカー指定は不要です。

配布用の macOS アプリをビルドする場合は次を実行します。

```sh
npm run tauri build
```

`.app` と DMG インストーラーを生成します。Apple Silicon 向けの出力先は次のとおりです。

- `src-tauri/target/release/bundle/macos/Colima GUI.app`
- `src-tauri/target/release/bundle/dmg/Colima GUI_0.1.0_aarch64.dmg`

ZIP 形式で配布する場合は、リソースフォークとアプリのディレクトリ構造を保持して圧縮します。

```sh
mkdir -p tmp/package
ditto -c -k --sequesterRsrc --keepParent \
  "src-tauri/target/release/bundle/macos/Colima GUI.app" \
  "tmp/package/Colima.GUI_0.1.0_aarch64.app.zip"
```

現在の設定は ad-hoc 署名です。Developer ID 署名と Apple の公証は行っていません。ダウンロードしたアプリの初回起動時には macOS の確認が必要です。配布方式は [Tauri の DMG 手順](https://v2.tauri.app/distribute/dmg/) と [macOS の署名手順](https://v2.tauri.app/distribute/sign/macos/)に従っています。

`RUSTUP_TOOLCHAIN` が環境変数に設定されている場合は `rust-toolchain.toml` より優先されます。異なるツールチェーンが選ばれる環境では、例えば `RUSTUP_TOOLCHAIN=1.97.1 npm run tauri dev` のように指定してください。

## 検証と受け入れ条件

```sh
npm run check
npm run test:rust
npm run test:e2e
```

`test:e2e` は WebdriverIO の embedded WebDriver を使い、macOS 上の実際の Tauri アプリを操作します。IPC のモックで成功を代用せず、GUI の完了表示と、別プロセスの Colima／Docker CLI から観測した実状態の両方を検証します。

| 操作 | 完了の確認 |
| --- | --- |
| プロファイル作成・起動 | `Running`、指定した CPU／メモリ／ディスク容量、Docker daemon への接続成功 |
| 同名プロファイルの作成 | GUI にエラーを表示し、作成前後で元プロファイルの実状態が変わらない |
| コンテナ一覧・ログ | 専用コンテナの表示と、そのコンテナが出力した文字列の表示 |
| コンテナ停止・起動 | Docker inspect の状態が `exited`／`running` に変化 |
| プロファイル再起動 | `Running` への復帰、VM の boot ID の変化、Docker 接続成功 |
| プロファイル停止 | Colima の状態が `Stopped` に変化 |
| リソース変更 | 再起動後に指定した値を CLI で確認 |
| プロファイル削除 | Colima の一覧と GUI の一覧から消える |
| 既存環境の保持 | 専用テストの対象外である既存プロファイルの情報と、実行前の Docker context が変わらない |

テストは一意の `cgui-e2e-*` プロファイルを 2 CPU・2 GiB メモリ・10 GiB ディスクで作成し、その中だけでコンテナを準備します。資源変更の検証では 3 CPU・3 GiB・11 GiB に拡張します。Colima の VM イメージとコンテナイメージの取得にはネットワーク接続が必要です。

終了時は成功・失敗にかかわらず、テスト専用プロファイルとデータを削除します。実行前の状態、各操作の観測値、スクリーンショット、結果、後片付けの記録は、Git の対象外である `tmp/e2e/<プロファイル名>/` に保存します。

2026-10-31 に macOS／Apple Silicon、Colima 0.10.3、Node.js 26.12.0、Rust 1.97.1 で検証しました。実アプリの E2E 13 項目、Rust の 13 テスト、TypeScript の型検査、Rustfmt、Clippy（`--all-targets --all-features -- -D warnings`）が合格しています。通常版の `.app` もビルドし、起動後に実プロファイルとコンテナの一覧を表示できることを確認しました。

## 実装の方針

フロントエンドは Tauri の型付きコマンドを呼び出し、Rust が許可した Colima／Docker の操作を引数配列で実行します。シェル経由の任意コマンド実行は提供しません。変更操作は直列化し、CLI の終了コードに加えて操作後の状態を確認してから成功を返します。

起動時は `--activate=false` を指定し、起動したプロファイルへの Docker context の自動切り替えを防ぎます。コンテナ操作では、選択したプロファイルの `status --json` が返す socket を明示します。

操作対象自身の Docker context は、Colima 標準の停止・削除処理で除去されます。現在選択中の context に対応するプロファイルを停止・再起動・削除すると、Docker 側の context 選択が変わる場合があります。別プロファイルの context は削除しません。E2E は有効な context を専用プロファイルへ切り替えず、既存の context が保持されることを検証します。

テスト用 WebDriver とその権限は `e2e` feature／設定で有効にし、通常ビルドには含めません。

設計上の選択肢と理由は [ADR](docs/adr/0001-desktop-colima-control.md) に記録しています。

## 参照した公式資料・Agent Skill

- [Tauri 2: Rust コマンドの呼び出し](https://v2.tauri.app/develop/calling-rust/)
- [Tauri 2: WebDriver テスト](https://v2.tauri.app/develop/tests/webdriver/)
- [WebdriverIO: Tauri プラグインの設定](https://webdriver.io/docs/desktop-testing/tauri/plugin-setup)
- [Colima 公式 Agent Skill](https://github.com/abiosoft/colima/blob/main/skills/SKILL.md)
- [Colima: 非対話操作・準備完了確認・後片付け](https://github.com/abiosoft/colima/blob/main/skills/references/automation.md)
- [Colima: 設定とプロファイル](https://github.com/abiosoft/colima/blob/main/skills/references/configuration.md)
- [Colima 0.10.3 の一覧処理](https://github.com/abiosoft/colima/blob/v0.10.3/cmd/list.go)、[起動処理](https://github.com/abiosoft/colima/blob/v0.10.3/cmd/start.go)、[再起動処理](https://github.com/abiosoft/colima/blob/v0.10.3/cmd/restart.go)
- [Colima 0.10.3 のプロファイル名と別名の解釈](https://github.com/abiosoft/colima/blob/v0.10.3/config/profile.go)

Colima の Agent Skill は `main` ブランチの資料です。実装に用いるフラグと JSON の形式は、対象バージョンの CLI help とソースに照合しています。
