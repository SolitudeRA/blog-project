---
article_id: '895c8f601bd9217913d1a253512a97a9'
title: 'ホームサーバー完全構築ガイド #7 DevOpsプラットフォームの構築'
series: ホームサーバー完全構築ガイド
emoji: 🌃
type: tech
tags:
  - devops
  - git
  - cicd
  - nginx
  - homeserver
---

# はじめに

**ホームサーバー完全構築ガイド**シリーズへようこそ。このシリーズでは、ホームサーバー環境を最大限に活用するため、インフラ構築から各種サービス導入、セキュアな通信環境構築、そしてクラウドストレージの運用まで、幅広いトピックを扱っています。前回は**Nextcloud**を導入し、プライバシーと柔軟性を重視したパーソナルクラウド環境を構築しました。

今回は、継続的[VCS](https://en.wikipedia.org/wiki/Version_control)と[CI/CD](https://www.redhat.com/en/topics/devops/what-is-ci-cd)、いわゆる[DevOpsプラットフォーム](https://www.redhat.com/en/topics/devops)の構築を取り上げます。コードのバージョン管理からビルド、テスト、デプロイまでを自動化し、小規模ながら効率的な開発・運用サイクルをホームサーバー上で実現することがゴールです。

本記事は、DevOpsツールに触れたことがない初心者にも理解しやすいように、ツール選定のポイントやセットアップ手順をわかりやすく解説します。さらに、軽量ツールから本格的なソリューションまで比較を行い、用途に応じて適切な構成を選べるようにします。

TL:DR 

[Gogsのインストール](Gogsのインストール)

[WoodpeckerCIのインストール](WoodpeckerCIのインストール)

[Jenkinsのインストール](Jenkinsのインストール)

# バージョン管理システム

ホームサーバー上でDevOpsツールチェーンを構築する際、まず必要になるのがバージョン管理システム（VCS）です。ソースコードを一元的に管理し、チームメンバー（あるいは自分自身）での共同開発をスムーズにします。代表的なGitホスティングツールを比較してみましょう。

## VCSツールの比較

| 項目             | Gogs                           | Gitea                           | GitLab                              |
| ---------------- | ------------------------------ | ------------------------------- | ------------------------------------ |
| リソース使用量   | 非常に軽量                     | 軽量だがGogsより若干上          | 中規模～大規模向けで比較的重い       |
| 機能             | 基本的なGitリポジトリ管理機能 | Gogs＋拡張機能、Issue・Wiki標準 | Issueトラッキング、CI/CD等機能豊富   |
| セットアップ難易度 | 非常に簡易                    | 比較的簡易                      | やや複雑                              |
| 適用範囲         | 個人・小規模プロジェクト       | 小～中規模プロジェクト          | 中～大規模組織・エンタープライズ向け |
| 拡張性・柔軟性   | 最小限                         | ある程度あり                    | 非常に高い                            |

## Gogsを選んだ理由

ホームサーバー環境で Git ホスティングを行うにあたり、**Gogs** を選んだ理由を以下にまとめます。

#### **軽量で効率的**
私のサーバー構成（Intel® Celeron® J6412、8GB メモリ）では、リソース使用量が少ないツールが必要です。Gogs は Go 言語で実装され、軽量で動作も非常に高速です。GitLab のような重いツールに比べてメモリ消費量が少なく、日常的な運用に十分対応できます。

#### **セットアップが簡単**
Gogs は単一バイナリで提供され、Docker を使ったセットアップも数分で完了します。シンプルな構成で依存関係も少ないため、初心者でも迷わず導入可能です。

#### **日常ニーズに最適**
個人や小規模プロジェクトを対象とした運用では、Gogs の基本機能（リポジトリ管理、Issue トラッキング、Wiki）で十分です。また、ストレージ容量（256GB mSATA）を効率的に活用でき、長期運用にも適しています。

## Gogsのインストール

### 前提

> Dockerのインストールは以下の文章を参照できます:
> 
> <<<article:339243802597e8c42bcddfb10b5e94e3>>>

**サーバー環境**：
  - Docker および Docker Compose がインストールされていること
  - サーバーにポート 3000（Web UI）と 22（SSH）が空いていること
  
**必要ディレクトリ**：
  - `/opt/gogs/data`（Gogs のデータを保存するための永続化用）

Gogsを導入する前に、基本となるGitがインストールされていることを確認しましょう。Gitが未インストールの場合は、以下のコマンドで導入します（Ubuntu例）。

```bash
sudo apt update
sudo apt install git -y
```

インストール後、`git --version` でバージョンが表示されればOKです。

Gogs は、公式 Docker イメージを利用することで、手軽にセットアップできます。以下は Docker を使った Gogs のインストール手順です。

### ディレクトリ作成

まず、Gogs 用の永続化データを保存するディレクトリを作成します。

```bash
mkdir -p /opt/gogs/data
cd /opt/gogs
```

### Docker コンテナの起動

以下のコマンドを実行して Gogs コンテナを起動します。

```bash
docker run -d --name=gogs --restart=always \
 -p 3000:3000 -p 22:22 \
 -v /opt/gogs/data:/data \
 gogs/gogs:latest
```

- `-p 3000:3000`：ホストのポート 3000 を Gogs の Web UI にマッピング
- `-p 22:22`：ホストのポート 22 を Gogs の SSH サーバーにマッピング
- `-v /opt/gogs/data:/data`：Gogs のデータ永続化用ボリュームをマウント
- `--restart=always`：サーバー再起動時に自動でコンテナを起動

### 初期セットアップ

コンテナが正常に起動したら、ブラウザで以下にアクセスします。

```
http://<サーバーのIPまたはドメイン>:3000
```

初回アクセス時にはセットアップ画面が表示されます。必要情報を入力して Gogs を構成します。
- **データベース**：SQLite を選択する場合は設定不要（軽量環境に最適）。
- **リポジトリパス**：`/data/git`（デフォルトを推奨）。

セットアップ完了後、管理者アカウントを作成してログインできます。

### Docker Compose を使用する場合（オプション）

Docker Compose を使った管理が必要な場合は、以下のような `docker-compose.yml` を作成してください。

```yaml
version: '3'
services:
  gogs:
    image: gogs/gogs:latest
    container_name: gogs
    restart: always
    ports:
      - "3000:3000"
      - "22:22"
    volumes:
      - /opt/gogs/data:/data
```

以下のコマンドでコンテナを起動します。

```bash
docker-compose up -d
```

### Nginx リバースプロキシ設定（HTTPS対応）

> Nginxのインストールは以下の文章を参照できます:
> 
> <<<article:339243802597e8c42bcddfb10b5e94e3>>>

Gogs をセキュアに公開するため、Nginx を使用したリバースプロキシを構成します。Nginx の設定例は以下です。

```nginx
server {
    listen 80;
    server_name git.example.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl;
    server_name git.example.com;

    ssl_certificate     /etc/ssl/certs/example.com.pem;
    ssl_certificate_key /etc/ssl/private/example.com.key;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

設定を適用して、ブラウザで `https://git.example.com` にアクセスすると、Gogs にセキュアに接続できます。

# CI/CDツールチェーンの導入

VCS環境が整ったら、次はCI/CDツールの導入を紹介します。

## CI/CDツールの比較と選定

ホームサーバー上で効率的な開発環境を整えるには、適切なCI/CDツールを選ぶことが重要です。以下では、代表的なCI/CDツールを比較し、特徴や適用範囲を解説します。

### CI/CDツールの比較表

以下は代表的なCI/CDツールを比較した表です。各ツールの特徴、適用範囲、リソース要件などを簡潔にまとめました。

| **特性**               | **Woodpecker CI**                              | **Drone CI**                              | **Jenkins**                                  | **GitHub Actions**                     |
|-----------------------|--------------------------------------------|----------------------------------------|--------------------------------------------|--------------------------------------|
| **位置付け**          | 軽量・自ホスト型CI/CD                        | 軽量・自ホスト型CI/CD                   | 高度な柔軟性と拡張性を持つ大規模CI/CDツール      | クラウド型・GitHubプラットフォーム統合型 |
| **必要なスペック**        | 低                                         | 低                                     | 中～高                                      | クラウド運用のためローカルリソース不要     |
| **実装方法**           | 自ホスト型、Dockerベースのパイプラインを使用      | 自ホスト型、Dockerベースのパイプラインを使用   | 自ホスト型、プラグインで拡張可能、多様な実行環境に対応 | GitHubが提供するホスト型Runner           |
| **使いやすさ**         | シンプル、YAMLファイルでパイプラインを定義可能     | シンプル、YAMLファイルでパイプラインを定義可能 | 初心者にはやや学習コストが高い、設定が複雑        | シンプル、YAMLファイルでワークフローを定義 |
| **拡張性**             | 中程度、コミュニティプラグインで機能を追加可能      | 中程度、コミュニティプラグインで機能を追加可能 | 高い、豊富なプラグインエコシステムを持つ          | 低い、GitHubのエコシステムに依存          |
| **コミュニティサポート** | 活発、コミュニティ駆動型開発                   | 活発、コミュニティからの幅広いサポート        | 活発、多数の開発者とプラグインによる支援          | 非常に活発、GitHub公式サポート            |
| **適用プロジェクト規模** | 小規模～中規模                              | 小規模～中規模                          | 中規模～大規模                               | 小規模～中規模                          |
| **実行環境**       | 主にDockerコンテナ環境で実行                   | 主にDockerコンテナ環境で実行              | 仮想マシン、物理マシン、Dockerなど多様な環境対応  | クラウド環境のみ（自ホストRunnerが必要）     |
| **統合能力**           | GiteaやGogsなど軽量なGitサービスとの相性が良い      | GiteaやGogsなど軽量なGitサービスとの相性が良い  | 多様なGitサービスやDevOpsツールと深く統合可能     | GitHubと完全にシームレスな統合           |
| **学習コスト**         | 簡単                                       | 簡単                                   | 高い、Jenkinsfileやプラグイン設定の学習が必要      | 簡単、GitHubユーザーに適した設計           |
| **経済的なコスト**             | 無料                                       | 無料                                   | 無料（自ホスト環境が必要）、有料プランも存在       | 無料（公共Runnerは制限あり）、有料プランも利用可 |

### ツール選択のポイント

#### **Woodpecker CI** と **Drone CI**
- **軽量性**と**シンプルな設定**が特徴で、リソースの限られたホームサーバー環境に最適。
- YAMLファイルで簡単にパイプラインを定義可能。
- **Gogs**や**Gitea**などの軽量なGitホスティングツールとの相性が良い。

#### **Jenkins**
- **高度な柔軟性**と**拡張性**を求める中～大規模プロジェクトに適しています。
- 多様な実行環境をサポートし、複雑なCI/CDワークフローを構築可能。
- 初期設定や運用には学習コストがかかるため、中級者以上に推奨。

#### **GitHub Actions**
- GitHubに完全統合されているため、GitHubユーザーには最適。
- クラウドでの運用が可能で、ローカルサーバーのリソース消費を削減。
- GitHub外部のサービスとの連携や拡張性には制限がある。

### ホームサーバーに適した選択（半年後の振り返り）

最初に私が選んだCI/CDツールは、有名で多機能な**Jenkins**でした。あらゆる環境や複雑なワークフローに柔軟に対応できる点に惹かれ、導入当初は「これで万全だ」と考えていました。

しかし、この半年間、実際に使い続けてみて、私自身の環境や利用頻度にはJenkinsはオーバースペックだったと痛感しました。以下に、その気づきをまとめます。

#### Jenkinsを使って感じた課題
1. **設定の複雑さ**  
   初期設定からプラグイン管理まで、とにかく自由度が高い分、学習コストも相応に高くなります。細かい調整に多くの時間を割くうちに、「ここまで手間をかける必要があるのだろうか？」と疑問が湧いてきました。

2. **使用頻度の低さ**  
   個人開発の範囲だと、複雑なDevOpsフローはあまり求められません。Jenkinsが持つ強力な機能を活かせる場面はほとんどなく、「宝の持ち腐れ」状態でした。

3. **リソースコスト**  
   軽量とは言えないJenkinsを8GBメモリのサーバーで動かしていると、明らかに重さを感じます。ほとんど使わないツールが貴重なリソースを消費するのは、非効率極まりないと感じました。

#### GitHub Actionsを試してみて
その後、<<<article:486d1bcca039ee9a86c874e92e62b8e2>>>を通じて**GitHub Actions**に触れる機会がありました。GitHubとシームレスに統合されているため、セットアップは驚くほど簡単。以下の点が特に気に入りました。

1. **導入の手軽さ**  
   GitHubリポジトリにYAMLファイルを1つ追加するだけで、CI/CD環境がすぐに整います。直感的な操作で、初学者にも優しいと感じました。

2. **クラウド実行によるリソース削減**  
   ホームサーバーのリソースを使わず、GitHub側でワークフローが実行されるため、ローカル環境への負荷が大幅に軽減。これは想像以上に快適でした。

#### 最終的にWoodpecker CIへ
そして、最終的にたどり着いたのがGitHub Actionsの使用感に近い**Woodpecker CI**です。私がこれを選んだ理由は以下のとおりです。

1. **低リソースでの安定稼働**  
   Intel® Celeron® J6412＋8GBメモリ程度の環境でも、Woodpecker CIは軽快に動きます。最低限のCI/CDパイプラインを構築するには十分で、無理なく運用できました。

2. **個人プロジェクトに適した機能範囲**  
   Woodpecker CIは機能がシンプルで、私が本当に必要としている要素のみをカバーしてくれます。過剰な機能に惑わされることなく、効率的に使える点が魅力です。

3. **自ホスト型の安心感**  
   クラウドに依存せず、ローカル環境で完全にコントロールできるため、セキュリティや安定性の面でも安心して利用できます。

#### **結論：自分に合ったツールが最良の選択**
この半年間の試行錯誤を経て強く感じたことは、「どれほど有名で高機能なツールでも、自分のニーズと合わなければ意味がない」ということです。結局、気軽に使い続けられるツールこそが、ホームサーバー運用において本当に価値のある選択肢でした。

自分の環境、スキル、目標にマッチしたツールを選ぶこと。それが、長期的に見てもストレスの少ない、持続可能な開発環境につながるのだと思います。

以下は「WoodpeckerCIのインストール」と「Jenkinsのインストール」の章を、提示いただいた参考リンクと設定例に基づいてまとめた内容です。

## WoodpeckerCIのインストール

### 前提
- Dockerおよびdocker-composeがインストールされていること
- Gitリポジトリを管理しているサーバー上またはアクセス可能な環境であること

### 手順概要
Woodpecker CIは、公式ドキュメント（[Getting Started](https://woodpecker-ci.org/docs/administration/getting-started) および [Docker Composeによるデプロイ方法](https://woodpecker-ci.org/docs/administration/deployment-methods/docker-compose)）に詳しい手順が記載されています。以下は、基本的な流れの例です。

#### 1. Docker Composeファイルの作成
   プロジェクト用ディレクトリを作成し、`docker-compose.yml`を設置します。Woodpecker CIの`server`と`agent`サービスを定義することで、セルフホスト型のCI/CD環境を用意できます。  
   例（公式ドキュメント参照）:
   ```yaml
   version: '3'

   services:
     server:
       image: woodpeckerci/woodpecker-server
       container_name: woodpecker-server
       volumes:
         - ./data:/var/lib/woodpecker
       environment:
         - WOODPECKER_OPEN=true
         - WOODPECKER_ADMIN=admin
         - WOODPECKER_SERVER_ADDR=:8000
         - WOODPECKER_AGENT_SECRET=<ランダムな文字列>
       ports:
         - "8000:8000"
         - "9000:9000"

     agent:
       image: woodpeckerci/woodpecker-agent
       container_name: woodpecker-agent
       volumes:
         - /var/run/docker.sock:/var/run/docker.sock
       environment:
         - WOODPECKER_SERVER=http://woodpecker-server:9000
         - WOODPECKER_AGENT_SECRET=<ランダムな文字列>
   ```

#### 2. 起動
   ```bash
   docker-compose up -d
   ```
   起動後、`http://<サーバーのIP>:8000`へアクセスすると、Woodpecker CIの管理画面が利用可能になります。

#### 3. リポジトリ連携
   Gitリポジトリ（GogsやGitHubなど）と連携することで、プッシュやプルリクエスト時にCIジョブを実行できます。詳細な設定は、各ソースリポジトリとの認証・統合方法をWoodpecker CI公式ドキュメントを参照しながら行います。

#### 4. Nginxによるリバースプロキシ設定例

#### 4. Nginxによるリバースプロキシ設定例

以下は、Woodpecker CIをNginxでリバースプロキシする際の設定例です。参考元は[Woodpecker CI公式ドキュメント（Advanced/Proxy/Nginx）](https://woodpecker-ci.org/docs/administration/advanced/proxy#nginx)を参照しています。

```nginx
# HTTPアクセスをHTTPSへリダイレクト
server {
    listen 80;
    listen [::]:80;
    server_name ci.example.com;
    
    # HTTPでのアクセスはすべてHTTPSへリダイレクト
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ci.example.com;

    # SSL証明書と秘密鍵の指定
    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    # セキュリティ関連ヘッダやSSL設定は適宜追加
    add_header X-Content-Type-Options "nosniff";
    add_header Strict-Transport-Security "max-age=31536000" always;

    # Woodpecker CIへのプロキシ設定
    location / {
        proxy_pass          http://localhost:8000;   # Woodpecker CI serverへの接続先
        proxy_http_version  1.1;
        proxy_buffering     off;
        
        # 必要なヘッダー設定
        proxy_set_header Connection          '';
        proxy_set_header X-Forwarded-Proto   https;
        proxy_set_header Host                $host;
        proxy_set_header X-Forwarded-For     $remote_addr;
        proxy_set_header Upgrade             $http_upgrade;
        proxy_set_header Connection          $connection_upgrade;
        
        # タイムアウト値調整（必要に応じて変更）
        proxy_read_timeout 900;
    }
}
```

**ポイント：**  
- **TLS/SSL設定**：`ssl_certificate`や`ssl_certificate_key`でSSL証明書と秘密鍵を指定します。  
- **HTTP→HTTPSリダイレクト**：80番ポートへのアクセスはすべて443へリダイレクトし、常時HTTPS通信を行います。  
- **ヘッダの適正化**：`X-Forwarded-Proto`や`Host`ヘッダーを適切にセットすることで、Woodpecker CI側が正しい外部URLやプロトコルを把握できます。  
- **`proxy_buffering off`**：Woodpecker CIのストリームやログ出力がリアルタイムで反映されるようにバッファリングを無効化しています。

## Jenkinsのインストール

### 前提
- Debian/Ubuntu系Linux環境を想定
- Java（OpenJDK 11以降）のインストールが推奨

### インストール手順概要（Debian/Ubuntu）
公式ドキュメント（[Jenkins公式ドキュメント：Linuxインストール](https://www.jenkins.io/doc/book/installing/linux/#debianubuntu)）を参照し、以下の手順でJenkinsを導入します。

1. **Jenkins用リポジトリの登録**  
   ```bash
   curl -fsSL https://pkg.jenkins.io/debian-stable/jenkins.io-2023.key | sudo tee \
       /usr/share/keyrings/jenkins-keyring.asc > /dev/null
   echo deb [signed-by=/usr/share/keyrings/jenkins-keyring.asc] \
       https://pkg.jenkins.io/debian-stable binary/ | sudo tee \
       /etc/apt/sources.list.d/jenkins.list > /dev/null
   sudo apt-get update
   ```

2. **Jenkinsのインストール**  
   ```bash
   sudo apt-get install jenkins
   ```
   インストール後、`sudo systemctl start jenkins`でJenkinsを起動可能です。

3. **初期設定**  
   `http://<サーバーのIPまたはホスト名>:8080`にアクセスすると、初回起動時の初期設定ウィザードが表示されます。`/var/lib/jenkins/secrets/initialAdminPassword`に格納されている初期パスワードを用いてログインし、プラグインの導入や管理ユーザー設定を行います。

### Nginxによるリバースプロキシ設定例
Jenkinsを外部から安全にアクセスするため、NginxでSSL対応のリバースプロキシを構築できます。以下は提示された設定例です。

```nginx
upstream jenkins {
    keepalive 32;
    server 127.0.0.1:8080;
}

map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
}

server {
    listen 80;
    listen [::]:80;

    server_name ci.example.com;

    server_tokens off;

    # 任意のアクセスコントロールやトラストソース設定は適宜変更・削除
    # include /etc/nginx/trust_source/cloudflare;
    # deny all;

    access_log /var/log/nginx/jenkins/access80.log;
    error_log /var/log/nginx/jenkins/error80.log;

    return 301 https://$server_name$request_uri;
}

server {
    listen 443      ssl;
    listen [::]:443 ssl;

    http2 on;

    server_name ci.example.com;

    server_tokens off;

    # 任意のアクセスコントロール設定は適宜変更・削除
    # include /etc/nginx/trust_source/cloudflare;
    # deny all;

    # SSL証明書ファイルパスの例
    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;
    ssl_session_timeout 1d;
    ssl_session_cache shared:MozSSL:10m;
    ssl_session_tickets off;

    ssl_dhparam /path/to/dhparam.pem;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:...;
    ssl_prefer_server_ciphers off;

    add_header Strict-Transport-Security "max-age=63072000" always;

    ssl_stapling on;
    ssl_stapling_verify on;

    # 中間証明書やルートCA証明書パスも適宜変更
    # ssl_trusted_certificate /path/to/origin_ca_rsa_root.pem;

    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "SAMEORIGIN" always;

    resolver 1.1.1.1;

    access_log /var/log/nginx/jenkins/access443.log;
    error_log /var/log/nginx/jenkins/error443.log;

    root /var/run/jenkins/war/;
    ignore_invalid_headers off;

    location ~ "^/static/[0-9a-fA-F]{8}\/(.*)$" {
        rewrite "^/static/[0-9a-fA-F]{8}\/(.*)" /$1 last;
    }

    location /userContent {
        root /var/lib/jenkins/;
        if (!-f $request_filename){
            rewrite (.*) /$1 last;
            break;
        }
        sendfile on;
    }

    location / {
        sendfile off;
        proxy_pass         http://jenkins;
        proxy_redirect     default;
        proxy_http_version 1.1;

        proxy_set_header   Connection        $connection_upgrade;
        proxy_set_header   Upgrade           $http_upgrade;

        proxy_set_header   Host              $http_host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_max_temp_file_size 0;

        client_max_body_size       10m;
        client_body_buffer_size    128k;

        proxy_connect_timeout      90;
        proxy_send_timeout         90;
        proxy_read_timeout         90;
        proxy_request_buffering    off;
    }
}
```

この例ではドメイン名を`ci.example.com`、証明書パスを`/path/to/`配下にあるファイルへと置き換え、特定のアクセスコントロール関連ディレクティブ（`include /etc/nginx/trust_source/cloudflare;`および`deny all;`）をコメントアウトしています。実際の運用環境に合わせて、再度適宜修正・調整してください。

# まとめ

今回の記事では、ホームサーバー環境でのDevOpsツールチェーン構築について、軽量なGogsとWoodpecker CI、柔軟性の高いJenkinsを例に、それぞれの特徴とセットアップ方法を解説しました。リソース制限がある場合はGogsとWoodpecker CIを組み合わせ、複雑なワークフローが必要な場合はJenkinsを選ぶのが最適です。次回は、ホームサーバーを活用したスマートホームプラットフォームの構築についてお届けします。