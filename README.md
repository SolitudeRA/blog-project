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
│   ├── update_metadata.js  # メタデータの更新スクリプト
│   └── validate_articles.js # 公開前の安全性チェック
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

GitHub Actionsを使用してリポジトリを自動更新するには、**Personal Access Token (PAT)** を設定する必要があります。

#### 1. **Personal Access Tokenの生成**

1. GitHubの[Personal Access Token設定ページ](https://github.com/settings/tokens)にアクセス。
2. **"Generate new token"** をクリック。
3. 必要なスコープを選択：
   - **`repo`**: プライベートリポジトリへのアクセスを許可（プライベートリポジトリの場合）。
4. トークンをコピーして保存します（トークンは一度しか表示されません）。

#### 2. **Secretsへの登録**

1. リポジトリの **Settings** > **Secrets and variables** > **Actions** に移動します。
2. **"New repository secret"** をクリック。
3. 以下の情報を入力：
   - **Name**: `BLOG_PROJECT_TOKEN`  
   - **Secret**: 生成したトークンの値を貼り付け。
4. **保存**をクリック。

### **重要な注意点**

- **トークンの権限**：  
  トークンのスコープは必要最低限にすることを推奨します。一般的には `repo` スコープのみで十分です。

- **トークンの安全管理**：  
  トークンは第三者に漏れないよう、必ずGitHub Secretsに保存してください。

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

2. **`main` ブランチへのプッシュ**  
   変更を `main` ブランチにプッシュします。以下のようなコマンドを使用します：

   ```bash
   git add .
   git commit -m "Update articles"
   git push origin main
   ```

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
      - `articles/share` と `articles/qiita` 内の記事、およびmanifestが Qiita の子リポジトリ（例: `qiita-repo/pre-publish`）にコピーされ、コミット・プッシュされます。

   4. **Zennリポジトリへの分散**
      - `articles/share` と `articles/zenn` 内の記事、およびmanifestが Zenn の子リポジトリ（例: `zenn-repo/pre-publish`）にコピーされ、コミット・プッシュされます。

---

### 注意事項: 実際のリポジトリリンクの設定

GitHub Actions を使用する前に、`distribute.yml` ワークフローで指定されている Qiita と Zenn リポジトリのリンクを、あなたのリポジトリに変更してください。

#### 対応箇所:
以下の箇所でリポジトリ名を変更します：

```yaml
# Qiitaリポジトリ
with:
  repository: solitudeRA/qiita-repo  # ここを変更
  ref: main
  token: ${{ secrets.BLOG_PROJECT_TOKEN }}

# Zennリポジトリ
with:
  repository: SolitudeRA/zenn-repo  # ここを変更
  ref: main
  token: ${{ secrets.BLOG_PROJECT_TOKEN }}
```

#### 実例:
- Qiita リポジトリ: `your-username/your-qiita-repo`
- Zenn リポジトリ: `your-username/your-zenn-repo`

---

### 自動化の例: GitHub Actions

以下は、自動化された処理の概要です：

#### 1. 記事のメタデータを更新

- **スクリプト**: `update_metadata.js`
- **処理内容**:
  - 各記事の `local_updated_at` フィールドをファイルの最終更新日時で更新。

#### 2. Qiitaリポジトリへの分散

- **処理**:
  - `articles/share` と `articles/qiita` の記事を Qiita の子リポジトリ（例: `qiita-repo/pre-publish`）にコピー。
  - コピー後、変更内容をコミットしてプッシュ。

#### 3. Zennリポジトリへの分散

- **処理**:
  - `articles/share` と `articles/zenn` の記事を Zenn の子リポジトリ（例: `zenn-repo/pre-publish`）にコピー。
  - コピー後、変更内容をコミットしてプッシュ。

## 開発者向け情報

### スクリプト一覧

- **`validate_articles.js`**
  配布対象の記事をプラットフォーム別に検証し、破損ファイル、manifestとFront MatterのID不整合、曖昧なタイトル・シリーズ構造、解決不能なID参照を公開前に拒否します。

- **`update_metadata.js`**  
  `articles`ディレクトリ内のMarkdownファイルをスキャンし、各ファイルを最後に変更したGit commitのcommitter timestampを `local_updated_at` に反映します。ファイルシステムのmtimeには依存しません。

### デバッグ

以下のコマンドでローカル環境でスクリプトを実行できます：

```bash
# 記事ソースを検証
npm run validate:articles

# 自動テストを実行
npm test

# メタデータを更新
node scripts/update_metadata.js <directory>

# 更新後の配布用メタデータを検証
npm run validate:articles:distribution
```

`<directory>` には更新対象のディレクトリ（例: `articles/zenn` や `articles/qiita`）を指定してください。

--- 

## ライセンス

本リポジトリは [MITライセンス](LICENSE) のもとで公開されています。
