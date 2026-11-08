# ADR 0001: Tauri から Colima の操作完了を確認する

- 状態: 採用
- 日付: 2026-10-31

## 背景

Colima を GUI から操作し、操作の完了をテストで確認できるデスクトップアプリを作る。Tauri で実装することが要件であり、対象機能はプロファイルの一覧・作成・起動・停止・再起動・削除、CPU／メモリ／ディスク設定、およびコンテナの一覧・起動・停止・ログ表示とする。

Colima は既存の仮想マシンと Docker context を管理している。GUI の起動操作によって接続先を自動で切り替えず、受け入れテストではユーザーの既存環境を保持する構成が必要である。また、CLI の正常終了だけでは設定の反映や Docker daemon の利用可否を証明できない。

## 選択肢

| 判断 | 選択肢 | 採用理由 |
| --- | --- | --- |
| デスクトップ実装 | Tauri 2、その他のデスクトップ基盤 | 要件に従って Tauri 2 を採用する。UI は React／TypeScript、OS 上の処理は Rust が担う |
| Colima との接続 | Rust から既存 CLI を実行、フロントエンドへ汎用 shell 実行を公開、Colima の内部 API に依存 | 公式 CLI を固定した操作と引数で実行する。任意の shell 実行を公開せず、内部 API への依存を避ける |
| プロファイル名 | Colima の別名も許可、別名を入力段階で拒否 | `colima` と `colima-` で始まる名前を拒否する。Colima の名前変換によって、入力した名前と異なるプロファイルを操作することを防ぐ |
| 成功の判定 | 終了コードのみ、終了コードと操作後の状態 | 後者を採用する。Running に対する start のように、正常終了しても資源設定が変わらない場合を区別する |
| Docker の接続先 | グローバル context を変更、選択プロファイルの socket を明示 | socket を明示する。コンテナ操作のためにグローバル context を変更する必要がない |
| 受け入れテスト | IPC のモックのみ、実アプリと実 Colima による E2E | 実アプリの GUI を操作し、独立した CLI で後条件を検証する。モックのみでは実際の VM やコンテナの変化を証明できない |

## 決定

1. Rust 側に用途を限定した Tauri コマンドを定義し、Colima／Docker CLI をシェルを介さず引数配列で実行する。プロファイル名・コンテナ ID・リソース値を検証し、変更操作を直列化する。Colima 0.10.3 が `default` の別名として扱う `colima` と、短縮名を求める際に除去する `colima-` 接頭辞を持つ入力は、CLI 実行前に拒否する。新規作成では同名の存在も確認する。
2. 一覧は `colima list --json` の NDJSON から取得する。起動中のプロファイルの詳細と Docker socket は `colima status --json` から取得する。
3. 起動には `--activate=false` を使い、起動対象への Docker context の自動切り替えを防ぐ。再起動は停止と同フラグを指定した起動に分ける。コンテナ操作では対象 socket を `docker --host` に渡す。Colima 標準の停止・削除処理は操作対象自身の context を除去するため、その context が選択中であれば Docker 側の選択が変わる場合がある。別プロファイルの context は削除しない。
4. 操作後に Colima の状態、Docker daemon の応答、または Docker inspect の状態を確認して成功を返す。CLI の失敗やタイムアウトは GUI にエラーとして表示する。
5. 資源の適用は停止済みプロファイルを対象とし、指定した資源で起動する。ディスクの縮小は拒否する。削除は停止済みプロファイルに限定し、GUI で名前を再入力する。コンテナデータの削除は明示的な選択とする。
6. macOS の受け入れテストには、Tauri 公式資料が案内する WebdriverIO の embedded WebDriver を採用する。WebDriver の Rust／JavaScript プラグインと権限は E2E ビルドに限定する。
7. E2E は衝突しない `cgui-e2e-*` 専用プロファイルを作り、実コンテナの操作を検証する。同名作成の拒否では GUI のエラー表示と元プロファイルの実状態の保持を確認する。再起動は VM の boot ID の変化も確認する。有効な Docker context を専用プロファイルへ切り替えず、対象外の既存プロファイルと実行前の Docker context の保持を検証する。終了時に専用プロファイルとデータを削除する。
8. macOS 向け Rust ビルドでは、`.cargo/config.toml` で Apple Silicon／Intel の両ターゲットに `/usr/bin/clang` を指定する。`PATH` 上の他の C コンパイラに依存せず、macOS SDK と整合するリンカーを使用する。

## 結果

既存の Colima と Docker CLI をインストールする必要がある。新規プロファイルは Docker runtime とし、コンテナ管理も Docker を対象にする。macOS の実アプリでの動作を受け入れ対象とし、他 OS の動作は別途検証が必要になる。

E2E は仮想化、数 GiB のメモリ、イメージ取得のネットワーク接続を必要とする。型検査や Rust のテストと分けて実行し、スクリーンショットと CLI の観測値を `tmp/e2e/` に記録する。これらの実行時成果物は Git に含めない。

## 根拠

- [Tauri: Rust コマンド](https://v2.tauri.app/develop/calling-rust/)
- [Tauri: WebDriver](https://v2.tauri.app/develop/tests/webdriver/)
- [WebdriverIO: Tauri プラグイン設定](https://webdriver.io/docs/desktop-testing/tauri/plugin-setup)
- [Colima 公式 Agent Skill](https://github.com/abiosoft/colima/blob/main/skills/SKILL.md) と [非対話操作の指針](https://github.com/abiosoft/colima/blob/main/skills/references/automation.md)
- [Colima 0.10.3: list](https://github.com/abiosoft/colima/blob/v0.10.3/cmd/list.go)、[start](https://github.com/abiosoft/colima/blob/v0.10.3/cmd/start.go)、[restart](https://github.com/abiosoft/colima/blob/v0.10.3/cmd/restart.go)
- [Colima 0.10.3: プロファイル名と別名の解釈](https://github.com/abiosoft/colima/blob/v0.10.3/config/profile.go)
- [Colima 0.10.3: Docker 停止時の context 除去](https://github.com/abiosoft/colima/blob/v0.10.3/environment/container/docker/docker.go)、[context 処理](https://github.com/abiosoft/colima/blob/v0.10.3/environment/container/docker/context.go)
