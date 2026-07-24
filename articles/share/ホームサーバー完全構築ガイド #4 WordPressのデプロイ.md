---
article_id: 'e908faa15ad46dc89cb87bf2d5b5908c'
title: 'ホームサーバー完全構築ガイド #4 WordPressのデプロイ'
series: ホームサーバー完全構築ガイド
emoji: 🌃
type: tech
tags:
  - WordPress
  - Linux
  - nginx
  - homeserver
  - self-hosting
local_updated_at: '2024-11-11T18:53:24+09:00'
---

# はじめに

WordPressは世界で最も広く利用されているコンテンツ管理システム（CMS）であり、ブログから複雑な企業サイトまでさまざまな用途に対応しています。WordPressをローカルホームサーバーにデプロイすることは、サーバーやウェブサイトのアーキテクチャを理解する上で絶好の機会です。本ガイドでは、PHP環境の設定、Nginxの設定、SSL証明書のインストール、そしてよくあるトラブルシューティングも含め、ホームサーバー上でWordPressをデプロイする手順を詳しく説明します。

## DockerじゃなくてベアメタルでWordPressをデプロイする理由

WordPressをデプロイする際、Dockerなどのコンテナ環境を使用せず、ベアメタル（直接のサーバー環境）でデプロイするには以下のような理由があります。

1. **環境の直接管理が可能**  
   ベアメタルでのデプロイでは、Nginx、PHP、MySQLなど、サーバー環境の各設定を細かく制御できるため、環境ごとの特定の要件やカスタマイズが柔軟に可能です。Docker環境内ではコンテナの抽象化により一部設定が制約を受けることもありますが、ベアメタル環境ではその心配がなく、自由に設定を最適化できます。特に、学習者や開発者にとって、各コンポーネントの挙動を理解するためにはベアメタル環境での管理が効果的です。

2. **性能面での利点**  
   ベアメタル環境では、Dockerのようなコンテナ層がなく、システムリソースに直接アクセスできます。そのため、コンテナのオーバーヘッドがなく、限られたリソースを最大限に活用できます。特に、リソースが限られるホームサーバー環境や小規模なサーバーでは、ベアメタルの方が効率的で、パフォーマンスの向上が期待できます。

3. **トラブルシューティングのしやすさ**  
   ベアメタル環境では、すべてのシステムログ、ファイルシステム、設定ファイルに直接アクセスできるため、問題発生時には詳細なトラブルシューティングが可能です。Dockerなどのコンテナ環境では、抽象化層が原因でエラーの原因特定が難しくなる場合もあり、トラブルシューティングが複雑になることがあります。

4. **長期的な安定性**  
   ベアメタル環境では、コンテナのバージョン互換性や依存関係の管理による問題が発生しにくく、安定した稼働が期待できます。Docker環境では、バージョンの変化や依存関係の変更がWordPressの動作に影響を及ぼす可能性がありますが、ベアメタル環境ではこうした外部の変更に影響を受けにくく、一度設定が完了すれば長期間安定して運用できます。

---

# デプロイ前の準備

まずは、以下の必要なサービスと環境がホームサーバーにインストールされていることを確認してください：

- **PHP 8.3**：WordPressは新しいPHPバージョンを推奨しており、性能とセキュリティの向上が期待できます。
- **MySQL**：データベースサービスがインストールされ、設定されていることを確認します。
- **Nginx**：リバースプロキシで使用されます。

## WordPressに必要なPHPモジュールのインストール

WordPressは複数のPHP拡張モジュールに依存しているため、これらをすべてインストールすることで機能が完全に使用可能になります。以下はWordPressが推奨するPHPモジュールです：

```bash
sudo apt install php8.3 php8.3-fpm php8.3-mysql php8.3-xml php8.3-curl php8.3-gd php8.3-mbstring php8.3-zip php8.3-soap php8.3-intl php8.3-bcmath php8.3-imagick
```

各モジュールの主な機能は以下の通りです：
- **php8.3-mysql**：MySQLデータベースへの接続に使用され、WordPressのデータベースアクセスの基本モジュールです。
- **php8.3-xml**：XMLデータの処理に必要で、RSSフィードやAPIデータの解析に必須です。
- **php8.3-curl**：HTTPリクエストをサポートし、外部サービスとの連携が容易になります。
- **php8.3-gd** と **php8.3-imagick**：画像処理に使用され、サムネイルの生成や画像サイズの調整を行います。
- **php8.3-mbstring**：マルチバイト文字列の処理をサポートし、異なるエンコーディングのコンテンツを処理できます。
- **php8.3-zip**：ファイルの圧縮/解凍に対応し、WordPressのデータのインポート/エクスポートに必須です。
- **php8.3-soap** と **php8.3-intl**：国際化機能やWebサービス統合に使用されます。
- **php8.3-bcmath**：高精度な数学演算を提供し、一部のプラグインやテーマで必要になります。

## PHP-FPMのインストール

PHP-FPM（FastCGI Process Manager）は、PHPリクエストを処理するための高度なプロセスマネージャーです。以下のコマンドでPHP-FPMをインストールし、Nginxに対応させます：

```bash
sudo apt install php8.3-fpm
```

#### PHP-FPMを選ぶ理由

PHP-FPMは高並列処理環境に最適化されており、Nginxと組み合わせてWordPressを構築する際に最適です。主な利点は次の通りです：

1. **Webサーバーとの分離**：PHP-FPMは独立して稼働するため、リソースの管理が柔軟になり、mod_phpを直接サポートしないNginxに最適です。
2. **効率的なリソース管理**：PHP-FPMはPHP子プロセス数を動的に管理し、リソースを効率的に配分します。
3. **高並列処理**：PHP-FPMは大量の並列リクエスト処理を最適化しており、WordPressのような高トラフィックのアプリケーションに適しています。
4. **ログとデバッグのサポート**：PHP-FPMはエラーログや遅延リクエストログを提供し、性能分析や問題解決がしやすくなります。

## WordPressのダウンロードとインストール

公式サイトからWordPressの最新バージョンをダウンロードし、解凍します：

```bash
wget https://wordpress.org/latest.tar.gz
tar -xvf latest.tar.gz
```

解凍したWordPressフォルダを`/var/www/wordpress/`に移動し、Nginxユーザーに権限を付与します：

```bash
sudo mv wordpress /var/www/wordpress
sudo chown -R www-data:www-data /var/www/wordpress
```
---

## WordPress用のデータベースとユーザーの作成

WordPressが使用するデータベースと専用ユーザーをMySQLで作成します。通常、WordPress専用のユーザーを作成することで、セキュリティ面や管理のしやすさが向上します。

#### WordPress用の専用ユーザーを作成する理由

1. **セキュリティ**  
   rootユーザーを使用せずに専用ユーザーでデータベースにアクセスすることで、セキュリティが向上します。万が一WordPressが攻撃された場合でも、専用ユーザーの権限内に限定され、他のデータベースやシステムへの被害を最小限に抑えられます。

2. **権限管理**  
   専用ユーザーに対して、WordPressが利用する特定のデータベースのみアクセス権限を設定することで、誤操作や悪意ある操作が他のデータベースに影響を及ぼさないようにできます。

3. **管理とトラブルシューティングの簡便さ**  
   WordPress専用ユーザーの利用により、アプリケーションとデータベースのアクセス関係が明確になります。これにより、アクセス権の管理が容易になり、問題が発生した際にも迅速にトラブルシューティングが可能です。

4. **ベストプラクティスに従う**  
   データベース管理のベストプラクティスとして、各アプリケーションに専用ユーザーを設定することが推奨されています。これにより、アプリケーション間の独立性が保たれ、将来的なデータベースの拡張や移行、バックアップが容易になります。

---

#### データベースとユーザーの作成手順

1. **データベースの作成**  
   WordPress用のデータベースを作成します（例：`wordpress_db`）：

   ```sql
   CREATE DATABASE wordpress_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   ```

   `utf8mb4`と`utf8mb4_unicode_ci`を指定することで、マルチバイト文字や絵文字も適切に扱うことができます。

2. **ユーザーの作成と権限の付与**  
   WordPress専用のユーザーを作成し、作成したデータベースへのアクセス権限を付与します。

   ```sql
   CREATE USER 'wordpress_user'@'localhost' IDENTIFIED BY 'your_password';
   GRANT ALL PRIVILEGES ON wordpress_db.* TO 'wordpress_user'@'localhost';
   FLUSH PRIVILEGES;
   ```

   これにより、`wordpress_user`は`wordpress_db`に対して必要な操作を行う権限が与えられ、WordPressからデータベースにアクセスできるようになります。

---

## Nginxの設定

Nginxのインストールは<<<article:339243802597e8c42bcddfb10b5e94e3>>>を参照してください。

NginxがWordPressサイトを正しく解析できるよう、`/etc/nginx/sites-available/`に新しい設定ファイル`wordpress`を作成し、以下の内容を追加します：

```nginx
upstream php {
    server unix:/run/php/php8.3-fpm.sock;
}

server {
    listen 80      default_server;
    listen [::]:80 default_server;

    server_name your_domain.com www.your_domain.com default_server;

    server_tokens off;

    include /etc/nginx/trust_source/cloudflare;

    deny all;

    access_log /var/log/nginx/wordpress/access80.log;
    error_log /var/log/nginx/wordpress/error80.log;

    return 301 https://$server_name$request_uri;
}

server {
    listen 443      ssl;
    listen [::]:443 ssl;

    http2 on;

    server_name your_domain.com www.your_domain.com default_server;

    server_tokens off;

    include /etc/nginx/trust_source/cloudflare;

    deny all;

    ssl_certificate     /path/to/your/ssl_certificate.pem;
    ssl_certificate_key /path/to/your/ssl_certificate.key;
    ssl_session_timeout 1d;
    ssl_session_cache shared:MozSSL:10m;
    ssl_session_tickets off;

    ssl_dhparam /path/to/your/dhparam;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384:DHE-RSA-CHACHA20-POLY1305;
    ssl_prefer_server_ciphers off;

    add_header Strict-Transport-Security "max-age=63072000" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header Referrer-Policy "no-referrer-when-downgrade" always;
    add_header Feature-Policy "camera 'none'; microphone 'none';" always;

    ssl_stapling on;
    ssl_stapling_verify on;

    ssl_trusted_certificate /path/to/your/origin_ca_rsa_root.pem;

    resolver 1.1.1.1;

    access_log /var/log/nginx/wordpress/access443.log;
    error_log /var/log/nginx/wordpress/error443.log;

    root /var/www/wordpress;

    index index.php;

    location = /favicon.ico {
        log_not_found off;
        access_log off;
    }

    location = /robots.txt {
        allow all;
        log_not_found off;
        access_log off;
    }

    location / {
        try_files $uri $uri/ /index.php?$args;
    }

    location ~ \.php$ {
        include fastcgi.conf;
        fastcgi_intercept_errors on;
        fastcgi_pass php;
    }

    location ~*

 \.(js|css|png|jpg|jpeg|gif|ico)$ {
        expires max;
        log_not_found off;
    }

    location ~ /\.(ht|git|wp-config.php) {
        deny all;
    }
}
```
---

### 設定の説明
```nginx
upstream php {
    server unix:/run/php/php8.3-fpm.sock;
}
```

#### `upstream`設定

`upstream`ディレクティブは、NginxがPHPリクエストを処理するために後方にあるサーバーグループを定義します。ここでは`php`という名前で、PHP-FPM（FastCGI Process Manager）にUnixソケット経由で接続する設定です。このソケットは、PHP-FPMがリクエストを処理する効率的な方法として推奨され、HTTPリクエストの処理速度を最適化します。

---

```nginx
server {
    listen 80      default_server;
    listen [::]:80 default_server;

    server_name your_domain.com www.your_domain.com default_server;

    server_tokens off;

    include /etc/nginx/trust_source/cloudflare;

    deny all;

    access_log /var/log/nginx/wordpress/access80.log;
    error_log /var/log/nginx/wordpress/error80.log;

    return 301 https://$server_name$request_uri;
}
```

#### HTTPリクエストのリダイレクト設定

この`server`ブロックでは、HTTP（ポート80）での接続を受け付け、全てのリクエストをHTTPS（ポート443）にリダイレクトしています。

- **listen 80、listen [::]:80**：IPv4およびIPv6でHTTPリクエストを受け付けます。
- **server_name**：指定されたドメイン名でリクエストを処理します。
- **server_tokens off**：Nginxのバージョン情報をレスポンスヘッダーから非表示にしてセキュリティを向上させます。
- **include /etc/nginx/trust_source/cloudflare**：信頼されたクラウドフレアIPを含むファイルを読み込み、クライアントのIPを保持するために使用します。
- **deny all**：デフォルトではアクセスを拒否します。
- **access_log と error_log**：アクセスログとエラーログの出力先ファイルを指定します。
- **return 301 https://$server_name$request_uri**：すべてのHTTPリクエストをHTTPSへ永久リダイレクト（301リダイレクト）します。

---

```nginx
server {
    listen 443      ssl;
    listen [::]:443 ssl;

    http2 on;

    server_name your_domain.com www.your_domain.com default_server;

    server_tokens off;

    include /etc/nginx/trust_source/cloudflare;

    deny all;

    ssl_certificate     /path/to/your/ssl_certificate.pem;
    ssl_certificate_key /path/to/your/ssl_certificate.key;
    ssl_session_timeout 1d;
    ssl_session_cache shared:MozSSL:10m;
    ssl_session_tickets off;

    ssl_dhparam /path/to/your/dhparam;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384:DHE-RSA-CHACHA20-POLY1305;
    ssl_prefer_server_ciphers off;
```

#### HTTPSとSSLの設定

HTTPSをサポートするためのSSL設定です。

- **listen 443 ssl、listen [::]:443 ssl**：IPv4とIPv6両方でポート443を使用してHTTPSリクエストを受け付けます。
- **http2 on**：HTTP/2プロトコルを有効化し、ページの読み込み速度を最適化します。
- **ssl_certificate と ssl_certificate_key**：SSL証明書とその秘密鍵のパスを指定します。
- **ssl_session_timeout と ssl_session_cache**：SSLセッションのタイムアウトとキャッシュ設定を行い、再接続時のパフォーマンスを向上させます。
- **ssl_dhparam**：安全なキー交換を確保するためのDiffie-Hellmanパラメータファイルを指定します。
- **ssl_protocols**：TLSプロトコルのバージョンを指定し、古いプロトコルを無効化してセキュリティを強化します。
- **ssl_ciphers**：安全な暗号スイートを指定し、脆弱な暗号化を排除します。
- **ssl_prefer_server_ciphers off**：サーバーよりもクライアントの暗号スイートを優先します。

---

```nginx
    add_header Strict-Transport-Security "max-age=63072000" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header Referrer-Policy "no-referrer-when-downgrade" always;
    add_header Feature-Policy "camera 'none'; microphone 'none';" always;
```

#### セキュリティヘッダーの設定

セキュリティに関連するHTTPヘッダーを追加し、攻撃やリスクを減らします。

- **Strict-Transport-Security**：HSTS（HTTP Strict Transport Security）を有効にし、ブラウザにHTTPS接続を強制します。
- **X-Content-Type-Options**：MIMEスニッフィングを無効にし、コンテンツタイプに基づく攻撃を防ぎます。
- **X-Frame-Options**：クリックジャッキング防止のため、サイトをiframeに埋め込まれないようにします。
- **Referrer-Policy**：外部サイトにアクセスする際のリファラーポリシーを制限します。
- **Feature-Policy**：カメラやマイクなど、特定の機能の使用を制限します。

---

```nginx
    ssl_stapling on;
    ssl_stapling_verify on;

    ssl_trusted_certificate /path/to/your/origin_ca_rsa_root.pem;

    resolver 1.1.1.1;

    access_log /var/log/nginx/wordpress/access443.log;
    error_log /var/log/nginx/wordpress/error443.log;

    root /var/www/wordpress;

    index index.php;
```

#### SSL Staplingとリゾルバの設定

SSL Staplingやリゾルバの設定を行い、HTTPS接続のパフォーマンスと信頼性を向上させます。

- **ssl_stapling と ssl_stapling_verify**：SSL Staplingを有効にし、証明書検証のパフォーマンスを向上。
- **ssl_trusted_certificate**：信頼する証明書のパスを指定します。
- **resolver**：DNSリゾルバを指定し、ホスト名の解決をサポートします。

---

```nginx
    location = /favicon.ico {
        log_not_found off;
        access_log off;
    }

    location = /robots.txt {
        allow all;
        log_not_found off;
        access_log off;
    }

    location / {
        try_files $uri $uri/ /index.php?$args;
    }
```

#### 特定リクエストへの対応とURLリライト

WordPress特有のファイルやURLリライトの設定です。

- **location = /favicon.ico**：ファビコンへのリクエストではログを記録しない設定。
- **location = /robots.txt**：クローラー向けのrobots.txtファイルのリクエストを許可し、ログ記録を省略。
- **location /**：URLリライト設定で、ファイルが見つからない場合にWordPressの`index.php`にフォールバックさせます。

---

```nginx
    location ~ \.php$ {
        include fastcgi.conf;
        fastcgi_intercept_errors on;
        fastcgi_pass php;
    }
```

#### PHPファイルの処理

PHPファイルをPHP-FPMに転送する設定です。

- **location ~ \.php$**：拡張子が`.php`のリクエストをキャッチし、PHP-FPMで処理します。
- **include fastcgi.conf**：標準のFastCGI設定を読み込みます。
- **fastcgi_intercept_errors on**：エラーメッセージをNginxが処理できるようにします。
- **fastcgi_pass php**：上で定義したPHPの`up

stream`サーバーに転送します。

---

```nginx
    location ~* \.(js|css|png|jpg|jpeg|gif|ico)$ {
        expires max;
        log_not_found off;
    }

    location ~ /\.(ht|git|wp-config.php) {
        deny all;
    }
}
```

#### 静的リソースのキャッシュとアクセス制御

- **location ~* \.(js|css|png|jpg|jpeg|gif|ico)$**：画像、CSS、JavaScriptなどの静的リソースに最大のキャッシュ期間を設定し、リソースの読み込み速度を向上。
- **location ~ /\.(ht|git|wp-config.php)**：`.ht`、`.git`、および`wp-config.php`のような重要なファイルへのアクセスを禁止し、セキュリティを強化。

---

### 設定を保存して有効化

設定を保存したら、シンボリックリンクを作成してサイト設定を有効化し、Nginx設定の正確性をテストします：

```bash
sudo ln -s /etc/nginx/sites-available/wordpress /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

これで、NginxでのWordPress設定が完了し、HTTPSでの安全なアクセスや静的リソースの最適化が適用されます。

---

# インストールの完了と初期設定

ブラウザで`https://<your_domain>/wp-admin`にアクセスし、WordPressのインストールウィザードに従ってサイト情報や管理者アカウントを設定します。

#### セキュリティの推奨事項
- デフォルトのログインURLを変更し、セキュリティリスクを減らします。
- `/var/www/wordpress`のファイル権限を制限し、不正な改ざんを防ぎます。

---

## おすすめのプラグイン

WordPressサイトのパフォーマンス向上、セキュリティ強化、ユーザー体験の向上、SEO対策のために、以下のプラグインを推奨します。

1. **[Cloudflare](https://wordpress.org/plugins/cloudflare/)**  
   Cloudflareプラグインは、WordPressユーザーにワンストップの最適化とセキュリティサービスを提供します。このプラグインを使用することで、サイトをCloudflareプラットフォームと簡単に統合し、コンテンツ配信ネットワーク（CDN）、自動キャッシュクリア、DDoS防御、Webアプリケーションファイアウォール（WAF）などの多彩な機能が利用可能です。

   特に、「自動プラットフォーム最適化」（APO）機能を有効にすることで、WordPressサイトの読み込み速度が向上し、モバイルとデスクトップ両方でのユーザー体験が改善されます。また、ファイルの自動圧縮、画像の最適化、HTML・CSS・JavaScriptファイルの自動最小化も可能で、ページサイズを減らし、読み込み速度をさらに向上させます。さらに、SSL/TLS設定の管理、セキュアブラウジングの有効化、ユーザーデータの保護も簡単に行えるため、CloudflareプラグインはWordPressサイトの最適化と保護に不可欠なツールです。

2. **[Akismet](https://wordpress.org/plugins/akismet/)**  
   Akismetは強力なスパムコメントフィルター機能を持つプラグインで、スパムコメントを自動的に検出し削除することで、コメント欄の清潔さを保ちます。コメント管理にかかる時間を大幅に削減し、ユーザー体験を向上させます。

3. **[Enlighter](https://wordpress.org/plugins/enlighter/)**  
   Enlighterはコードのハイライト表示に対応したプラグインで、技術系ブログやコードの表示が必要なウェブページに適しています。さまざまなプログラミング言語とテーマスタイルをサポートし、コードを読みやすく、見やすく表示します。また、簡単にコードブロックを挿入できるエディターも提供しており、ユーザーが美しいコード表示を簡単に追加できます。

4. **[Polylang](https://wordpress.org/plugins/polylang/)**  
   Polylangは多言語サイトの作成に対応したプラグインです。複数の言語を手動で追加でき、翻訳ページのリンクも自動生成されます。Polylangを使用することで、サイトが世界中のユーザーに対応し、多言語化のニーズに適したサイト構築が可能です。

5. **[XML Sitemap Generator for Google](https://wordpress.org/plugins/google-sitemap-generator/)**  
   このプラグインは、Googleの要件に合致したXMLサイトマップを生成します。これにより検索エンジンがサイトコンテンツをより効率的にクロールし、SEOランキングが向上する可能性があります。サイトマップには、すべてのページ、記事、カテゴリ、タグのリンクが含まれ、サイトのインデックス化をサポートします。

6. **[Table Of Contents](https://wordpress.org/plugins/easy-table-of-contents/)**  
   Table Of Contentsプラグインは、記事内に目次を自動生成します。特に長文コンテンツに適しており、ユーザーが記事内の特定のセクションに素早くアクセスできるため、ユーザー体験の向上につながります。多彩なスタイルと位置設定が可能で、記事やページのさまざまな位置に簡単に組み込むことができます。

---

## よくある問題とトラブルシューティング

- **データベース接続エラー**：`wp-config.php`内のデータベース設定情報を確認し、正しく設定されていることを確認します。
- **権限エラー**：`/var/www/wordpress`ディレクトリの権限が適切に設定されていることを確認します（`chmod -R 755 /var/www/wordpress`を使用できます）。
- **ファイルアップロードの問題**：PHP設定ファイル内の`upload_max_filesize`や`post_max_size`を調整し、より大きなファイルのアップロードをサポートします。

---

# まとめ

本記事では、ホームサーバー上でNginxを使用してWordPressをデプロイするための詳細な手順を紹介しました。PHP環境の設定からNginxの構成、セキュリティの最適化まで、WordPressサイトが効率的に動作するための重要なポイントを解説しました。今後は、CDNの追加、画像の圧縮、HTTPリクエストの削減など、さらなる最適化を行うことで、サイトのパフォーマンスとユーザー体験を向上させることが可能です。
