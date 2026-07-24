# Qiita/Zenn同時対応ブログリポジトリ

ZennとQiitaへの記事管理や同時公開に対応した多端対応ブログリポジトリです。  
記事の自動更新、シリーズリンク生成、公開プロセスの効率化を実現します。

Sub Repos:

Zenn Repo: https://github.com/SolitudeRA/zenn-repo

Qiita Repo: https://github.com/SolitudeRA/qiita-repo

---

## 特徴

- **複数プラットフォーム対応**  
  ZennとQiitaへの同時公開をサポート。
  
- **シリーズリンクの自動生成**  
  `articles/share` `articles/zenn` `articles/qiita`ディレクトリの内容に基づき、シリーズリンクを自動的に生成し、記事に挿入します。

- **効率的な記事管理**  
  GitHub Actionsを活用して、記事の自動更新とコミットを実現。

- **簡単な設定**  
  必要な設定を整えるだけで、すぐに記事の管理と公開を開始できます。

---

## ディレクトリ構成

```
.
├── articles/        # 記事が格納されるディレクトリ
│   ├── manifest.json # 記事ID、ソース、配信先の正規レジストリ
│   ├── qiita/       # Qiita専用の記事
│   ├── share/       # ZennとQiitaの両方で共有される記事
│   └── zenn/        # Zenn専用の記事
├── scripts/         # 自動化スクリプト
│   ├── resolve_manifest_history.ts # 直前manifestのGit履歴解決
│   ├── update_metadata.ts  # メタデータの更新スクリプト
│   └── validate_articles.ts # 公開前の安全性チェック
├── .github/         # GitHub Actions設定
│   └── workflows/
│       └── distribute.yml # 公開処理を自動化するワークフロー
├── package.json     # Node.js依存関係と検証コマンド
├── package-lock.json # 固定された依存関係
├── LICENSE          # ライセンスファイル
└── README.md        # このファイル
```
---

## 必要なセットアップ

### 1. **リポジトリのクローン**

以下のコマンドでリポジトリをクローンします。

```bash
git clone https://github.com/SolitudeRA/Blog-Project.git
cd Blog-Project
```

### 2. **依存パッケージのインストール**

Node.jsがインストールされていることを確認し、以下のコマンドを実行してください。

```bash
npm ci
```

### 3. **GitHub Actionsを利用するためのSecretsの設定**

GitHub Actions が子リポジトリへ配布用 Pull Request を作成・更新するには、
**fine-grained Personal Access Token (PAT)** を設定する必要があります。

#### 1. **Personal Access Tokenの生成**

1. GitHubの[Personal Access Token設定ページ](https://github.com/settings/tokens)にアクセス。
2. **"Generate new token"** をクリック。
3. 対象リポジトリを `Qiita-Repo` と `Zenn-Repo` だけに限定します。
4. Repository permissions は次の最小権限を付与します。
   - **Contents: Read and write**
   - **Pull requests: Read and write**
   - **Metadata: Read-only**
5. トークンをコピーして保存します（トークンは一度しか表示されません）。

#### 2. **Secretsへの登録**

1. リポジトリの **Settings** > **Secrets and variables** > **Actions** に移動します。
2. **"New repository secret"** をクリック。
3. 以下の情報を入力：
   - **Name**: `BLOG_PROJECT_TOKEN`  
   - **Secret**: 生成したトークンの値を貼り付け。
4. **保存**をクリック。

### **重要な注意点**

- **トークンの権限**：  
  対象は2つの子リポジトリだけに限定し、Actions や Administration など
  配布に不要な権限は付与しません。

- **トークンの安全管理**：  
  トークンは第三者に漏れないよう、必ずGitHub Secretsに保存してください。
  子リポジトリの generator と依存関係は PAT を持たない runner で実行し、
  許可されたパスだけを含む patch artifact を作ります。別の新しい runner が
  patch を検証・適用した後、最終 publish step だけが PAT を受け取ります。

### 4. **articlesに記事を追加**

公開先に応じで`articles/share` `articles/zenn` `articles/qiita`ディレクトリにMarkdownファイルを作成し、適切なメタデータを追加します。例：

```markdown
---
article_id: "08828ec8b0719d4ae2ae640a6dd4867d"
title: "ホームサーバー完全構築ガイド #1 OS導入と基本設定"
series: "ホームサーバー完全構築ガイド"
tags:
  - "linux"
  - "selfhosting"
---
記事本文をここに書きます。
```

`article_id` は32桁の小文字16進数で、タイトルやファイル名を変更しても変えてはいけません。同じIDを別の記事へ再利用しないでください。

現在の自動配信スライスが安全に扱えるのは、manifestと両子リポジトリにすでに対応付けられた11記事の更新・改名だけです。新しい記事IDの自動onboardingは、Qiita側の安全な新規作成・再実行プロトコルが未実装のため、previous manifestとの履歴検証で停止します。第12記事を追加する場合は、両子リポジトリへの対応付けを含むonboarding手順を別途実装・確認してから開放してください。

すべての記事は `articles/manifest.json` にも登録します。Front Matterの `article_id` とmanifestの `article_id` は必ず一致させます。

```json
{
  "article_id": "08828ec8b0719d4ae2ae640a6dd4867d",
  "source": "articles/share/ホームサーバー完全構築ガイド #1 OS導入と基本設定.md",
  "article_state": "active",
  "targets": {
    "qiita": { "desired": "published" },
    "zenn": { "desired": "published" }
  }
}
```

`article_state` の予約値は `active`、`retiring`、`retired`、配信先の `desired` は `published`、`withdrawn` です。現在の自動配信は安全な撤回処理をまだ実装していないため、`active` と `published` 以外を検出すると停止します。記事を削除する場合もmanifestのエントリーを先に消さないでください。

ファイル名を変更する場合はmanifestの `source` も同じコミットで更新し、`article_id` は維持します。公開ワークフローはpush前のmanifestと比較し、既存IDの消失、既存sourceの別IDへの付け替え、配信先の暗黙削除を拒否します。初回導入として扱われるのは、基準コミットから到達可能なGit履歴にmanifestが一度も存在しない場合だけです。manifestを削除したコミットの後で再作成しても、直近の歴史上のmanifestまで遡って比較されるため履歴はリセットされません。

記事内リンクはタイトルではなく変更されないIDを参照します。

```markdown
<<<article:339243802597e8c42bcddfb10b5e94e3>>>
```

旧形式の `<<<記事タイトル>>>` は公開前検証で拒否されます。

## 使用方法

### 記事を分散する手順

1. **記事の追加または更新**  
   - `articles/share` ディレクトリに、Zenn と Qiita の両方で共有する記事を追加します。
   - `articles/zenn` ディレクトリには Zenn 専用の記事を追加します。
   - `articles/qiita` ディレクトリには Qiita 専用の記事を追加します。

2. **Blog-Project の Pull Request をマージ**
   変更を Pull Request として `main` に取り込みます。`distribute` check が
   成功した変更だけをマージしてください。

3. **GitHub Actionsによる自動処理**  
   プッシュがトリガーされると、GitHub Actions が以下の処理を自動で行います：

   1. **記事ソースの安全性チェック**
      - 空ファイル、NUL、壊れたUTF-8、Front Matter不備、重複タイトル、ファイル名衝突、シリーズ欠番、現在・過去manifestとの不整合、重複ID、解決できない `<<<article:article_id>>>` 参照をQiita/Zennの両方について検出します。
      - エラーがある場合は、子リポジトリのチェックアウトやプッシュを行う前に停止します。

   2. **`local_updated_at` の自動更新**
      - 各記事ファイルを最後に変更したGit commitのcommitter timestamp（strict ISO 8601）を `local_updated_at` に使用します。checkout時のファイルmtimeは使用しないため、無関係なpushや新しいrunnerで記事日時が変わることはありません。
      - 全記事のGit履歴とFront Matterを先に検証し、履歴なし・Gitエラー・解析エラーが1件でもあれば、どの記事も書き換えずに停止します。
      - 更新後に配布用メタデータを再検証します。

   3. **Qiitaリポジトリへの分散**
      - `articles/share` と `articles/qiita` 内の記事、およびmanifestから、
        固定の自動化ブランチを更新します。
      - `validate_and_publish` を required check とする Pull Request を作成し、
        check 成功後に GitHub の auto-merge が rebase merge します。
      - merge 後の Qiita `main` push でだけ、既存 binding の変更分を公開します。

   4. **Zennリポジトリへの分散**
      - `articles/share` と `articles/zenn` 内の記事、およびmanifestを
        自動化ブランチへコピーし、そのブランチ内で `articles/` と
        `article-map.json` も生成します。
      - `validate_pull_request` がソースと生成物の一致を読み取り専用で確認し、
        check 成功後に auto-merge が rebase merge します。
      - Zenn の `main` workflow は再検証だけを行い、追加 commit は作りません。

   子リポジトリ側のコードを実行する準備 job と、PAT を使う publish job は
   artifact 境界で分離されています。publish job は Blog-Project と target
   `main` を新規 checkout し、target の npm script や Git hook を実行しません。

---

### 注意事項: 子リポジトリの保護設定

自動配布を有効にする前に、両子リポジトリで rebase merge、auto-merge、
head branch の自動削除を有効にします。さらに `main` を対象とする active な
branch ruleset を作成し、strict required status check として Qiita は
`validate_and_publish`、Zenn は `validate_pull_request` を
GitHub Actions（App ID 15368）からの check に限定します。
ユーザーや Actions App の bypass は設定しません。bypass actor は
least-privilege PAT から取得する effective rules API には含まれないため、
有効化前と定期監査時にリポジトリ管理画面で人が確認します。

配布スクリプトは default branch、rebase merge、auto-merge、head branch
自動削除、および `main` に実際に適用される required check と App ID を
GitHub API で確認してから自動化ブランチを更新します。設定不足、複数の
同一 head PR、target `main` の同時更新、自動化ブランチへの人手による変更は
fail closed で停止します。

---

### 自動化の例: GitHub Actions

以下は、自動化された処理の概要です：

#### 1. 記事のメタデータを更新

- **スクリプト**: `update_metadata.ts`
- **処理内容**:
  - 各記事の `local_updated_at` フィールドをファイルの最終更新日時で更新。

#### 2. Qiitaリポジトリへの分散

- **処理**:
  - `articles/share` と `articles/qiita` の記事を Qiita の子リポジトリ（例: `qiita-repo/pre-publish`）にコピー。
  - 固定の配布ブランチを更新し、required check 待ちの Pull Request を
    find-or-create して rebase auto-merge を予約。

#### 3. Zennリポジトリへの分散

- **処理**:
  - `articles/share` と `articles/zenn` の記事を Zenn の子リポジトリ（例: `zenn-repo/pre-publish`）にコピー。
  - Zenn のロック済み依存関係で最終記事と binding map を生成。
  - ソースと生成物を同じ配布 PR に含め、required check 成功後に
    rebase auto-merge。

一時的な API 障害や target `main` の更新で同期が停止した場合は、
Blog-Project の Actions 画面から `Distribute Articles` の
`workflow_dispatch` を `main` に対して再実行できます。同じ固定ブランチと
PRを再利用するため、重複した配布 PR は作りません。

## 開発者向け情報

### スクリプト一覧

- **`validate_articles.ts`**
  配布対象の記事をプラットフォーム別に検証し、破損ファイル、manifestとFront MatterのID不整合、曖昧なタイトル・シリーズ構造、解決不能なID参照を公開前に拒否します。

- **`resolve_manifest_history.ts`**
  配布前の比較に使う直前manifestをGit履歴からfail-closedで解決します。

- **`update_metadata.ts`**
  `articles`ディレクトリ内のMarkdownファイルをスキャンし、各ファイルを最後に変更したGit commitのcommitter timestampを `local_updated_at` に反映します。ファイルシステムのmtimeには依存しません。

- **`distribute_target.ts`**
  検証済みスナップショットから子リポジトリの配布ブランチを決定的に再構築し、
  許可パスだけの patch envelope を export / fresh checkout へ apply します。
  required-check 設定、remote main、automation branch の所有権を確認してから、
  単一の Pull Request を作成・更新して auto-merge を予約します。

### デバッグ

以下のコマンドでローカル環境でスクリプトを実行できます：

```bash
# 記事ソースを検証
npm run validate:articles

# 自動テストを実行
npm test

# TypeScript移行ベースラインを検査
npm run typecheck

# メタデータを更新
node scripts/update_metadata.ts <directory>

# 更新後の配布用メタデータを検証
npm run validate:articles:distribution
```

`<directory>` には更新対象のディレクトリ（例: `articles/zenn` や `articles/qiita`）を指定してください。

--- 

## ライセンス

本リポジトリは [MITライセンス](LICENSE) のもとで公開されています。
