---
article_id: '08828ec8b0719d4ae2ae640a6dd4867d'
title: 'ホームサーバー完全構築ガイド #1 OS導入と基本設定'
series: ホームサーバー完全構築ガイド
emoji: 🌃
type: tech
tags:
  - Linux
  - Ubuntu
  - Server
  - homeserver
local_updated_at: '2024-11-11T18:51:48+09:00'
---
# **はじめに**

前回の記事では、ハードウェア選定と全体的なサービスアーキテクチャについて解説しました。今回は、実際にサーバーのセットアップを開始し、**Ubuntu 24.04.1 LTS** をインストールした後の基本的な設定やセキュリティ対策を行います。

ハードウェアの準備が整ったら、次のステップはOSのインストールです。Ubuntuの信頼性が高く、長期サポート（LTS）バージョンを選択することで、安定した運用が可能です。本文では、最新のUbuntu 24.04.1 LTSを採用しています。

## **注意点**
Ubuntuインストール中には、以下の点に注意してください：
1. **追加のソフトウェアを選択しない**  
   インストール中に表示される「オプションでインストール可能なパッケージ」（DockerやSSHサーバーなど）は、後に公式手順で導入することを推奨します。初期状態のシステムをできるだけシンプルに保つことで、不要な競合や古いバージョンのインストールを防げます。
   
2. **インストール後に必要な設定を手動で行う**  
   ネットワーク設定、セキュリティの強化、必要なソフトウェアの導入は、インストール後に一括して行うことで、環境全体の整合性を保ちます。

次に、Ubuntu 24.04.1 LTSのインストール手順を詳細に解説し、基本設定を進めていきます。

# 前提

- **ハードウェア**：Ubuntu LTSが問題なく稼働するサーバー用ハードウェア（またはPC）を用意する。
- **ネットワーク**：家庭内LANで、ルーターのポート転送を通してサービスを提供する環境を前提として想定する。
- **知識レベル**：Linuxコマンド、SSH操作、簡単な設定ファイルの編集が行える初学者～中級者を想定。

# Ubuntu LTSのインストール

## ISOイメージの取得とUSBメディア作成

1. **イメージのダウンロード**：  
   最新LTS版のUbuntu Serverを[公式サイト](https://ubuntu.com/download)からダウンロードする。例: `ubuntu-24.04.1-live-server-amd64.iso`。

2. **USBインストールメディアの作成**：  
   - **Windowsの場合**：[Rufus](https://rufus.ie/)などのツールを使用して、ISOイメージをUSBメモリに書き込む。
   - **Linux/macOSの場合**：`dd`コマンドで書き込む。例：  
     ```bash
     sudo dd if=./ubuntu-24.04.1-live-server-amd64.iso of=/dev/sdX bs=4M status=progress
     ```
     `/dev/sdX`はUSBメモリのデバイスを指定。

## BIOS/UEFI設定とインストーラ起動

サーバー（またはPC）を再起動し、BIOS/UEFI画面でUSBメモリを起動優先順位の先頭に設定する。設定を保存して再起動すると、Ubuntuインストーラが起動する。

## インストール手順のポイント

1. **言語選択**：日本語または英語など、必要に応じて選択する。
2. **ネットワーク設定**：DHCP環境で自動割り当てを利用。後で固定IPに設定を変更する。
3. **ストレージ設定（パーティション分割）**：LVM（Logical Volume Manager）を有効化しておくと、後から柔軟なストレージ管理が可能。特に初心者の場合、自動構成を推奨。
4. **ユーザー設定**：管理用ユーザーを作成し、強固なパスワードを設定する。
5. **SSHサーバーの有効化**：  
   OpenSSHサーバーを有効化しておくと、インストール後すぐにリモートアクセスが可能。

## システムアップデート

インストール完了後、まずローカルサーバー上でシステムを最新の状態に更新する：

```bash
sudo apt update
sudo apt upgrade -y
```

# sshdの設定

## 1.鍵ペア生成とアルゴリズム選択

### 鍵ペアの生成

鍵ペアを生成するには、以下のコマンドをサーバー上で実行する：

```bash
ssh-keygen -t ed25519 -C "server_local_key"
```

- 生成後、デフォルトで以下のファイルが作成される：
  - **秘密鍵**：`~/.ssh/id_ed25519`
  - **公開鍵**：`~/.ssh/id_ed25519.pub`

### 使用するアルゴリズムの選択

SSH鍵ペア生成時に選択可能な主なアルゴリズムの特徴は以下の通り：

| アルゴリズム   | 特徴                                                                 |
|----------------|----------------------------------------------------------------------|
| **ed25519**    | - 高速かつセキュア<br>- 鍵長が短いためストレージと速度に優れる<br>- 推奨 |
| **rsa**        | - 古くから利用される標準的なアルゴリズム<br>- 2048以上の鍵長が必要<br>- 後方互換性が高い |
| **ecdsa**      | - ed25519と同様の楕円曲線暗号方式<br>- 一部の古いシステムではサポートが限定的 |
| **dsa**        | - 非推奨。セキュリティ上の理由から利用を避けるべき                      |

**推奨：ed25519**  
ed25519は、速度・安全性・鍵の短さの点で最も優れており、現行の標準として推奨される。

## 2.公開鍵の設定

生成された公開鍵を認証に使用するため、以下を実行：

```bash
mkdir -p ~/.ssh
cat ~/.ssh/id_ed25519.pub >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

### sshdの設定変更

1. `/etc/ssh/sshd_config`ファイルを編集し、以下の設定を変更または追加する：

```plaintext
Port 2222 (好みに応じで変更)
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
```

2. 設定を保存後、sshdを再起動する：

```bash
sudo systemctl restart sshd
```

# ファイアウォール設定（UFW）

必要なポートだけを許可し、その他の接続を遮断する：

```bash
sudo apt install ufw
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 2222/tcp #（sshdを許可）
sudo ufw enable
```

# SSHでのリモートログインと後続作業

以降の作業は、別の端末からSSHでリモートログインして進める：

```bash
ssh -p 2222 user@192.168.1.100
```

---

# セキュリティ

## ファイアウォール（UFW）

[UFW（Uncomplicated Firewall）](https://help.ubuntu.com/community/UFW)は初心者にも扱いやすいファイアウォールです。

### 設定手順

#### インストールと初期設定

[ファイアウォール設定（UFW）](ファイアウォール設定（UFW）)で紹介したように、以下のコマンドでUFWの設定が行えます

```bash
sudo apt install ufw
sudo ufw default deny incoming
sudo ufw default allow outgoing
```

#### SSH用ポートの許可

SSHで利用するポート（例：2222）を許可：

```bash
sudo ufw allow 2222/tcp
```

#### UFWの有効化と確認

```bash
sudo ufw enable
sudo ufw status verbose
```

`enable`コマンド実行時に「Yes」を入力して有効化します。

## Fail2Banによる不正アクセス防止

Fail2Banは、不正なログイン試行を検知して自動的にIPアドレスをブロックします。

### 設定手順

#### インストール

```bash
sudo apt install fail2ban
```

#### 基本設定

`/etc/fail2ban/jail.local`（存在しない場合は新規作成）に以下を記載：

 ```plaintext
[sshd]
enabled = true
port = 2222
maxretry = 5
bantime = 600
logpath = /var/log/auth.log
```

- `port`：SSH用ポート番号。
- `maxretry`：ログイン試行の失敗を許可する回数。
- `bantime`：不正IPアドレスのブロック時間（秒）。

#### Fail2Banの有効化と起動

```bash
sudo systemctl enable fail2ban
sudo systemctl start fail2ban
```

#### ステータス確認

```bash
sudo fail2ban-client status
```

## ログ監視

サーバーで発生したイベントを監視するためのツールを導入します。

### **Glances**：リソースとログの総合監視ツール

[Glances](https://github.com/nicolargo/glances) は、CPU、メモリ、ディスク使用量、ネットワーク状況など、サーバーリソースを総合的にリアルタイムで監視できるツールです。初心者にも扱いやすく、視覚的なインターフェースを提供します。

#### インストール

```bash
sudo apt install glances
```

#### 起動

```bash
glances
```

起動後、画面にCPU、メモリ、ディスク使用状況、ネットワークアクティビティなどがリアルタイムで表示されます。

#### リモートでの使用

GlancesはWebサーバーモードでも使用可能です。リモートブラウザからアクセスできます：

```bash
glances -w
```

デフォルトではポート`61208`で待ち受けます。別の端末から以下のURLでアクセス：

```
http://<サーバーのIPアドレス>:61208
```

# 基本設定

## パッケージの自動更新

### 自動更新するパッケージの制御

`/etc/apt/apt.conf.d/50unattended-upgrades` ファイルを編集し、自動更新するパッケージの範囲をカスタマイズします。以下の内容を確認または追加してください：

```plaintext
Unattended-Upgrade::Allowed-Origins {
    "${distro_id}:${distro_codename}-security";
    "${distro_id}:${distro_codename}-updates";
    "${distro_id}ESM:${distro_codename}-infra-security";
    "${distro_id}ESMApps:${distro_codename}-apps-security";
};
```

- `${distro_id}:${distro_codename}-security`：Ubuntu公式セキュリティ更新（推奨）
- `${distro_id}:${distro_codename}-updates`：安定性向上のための更新（重要）
- `${distro_id}ESM:${distro_codename}-infra-security`：拡張セキュリティメンテナンス（ESM）の更新（有効化済みの場合）
- `${distro_id}ESMApps:${distro_codename}-apps-security`：ESMによるアプリケーションのセキュリティ更新

#### アドバイス

1. **不要な更新は避ける**  
   セキュリティ関連以外の更新（例：`-proposed`、`-backports`）は、未検証のパッケージが含まれる可能性があるため、自動更新から除外することを推奨します。

2. **ESMを活用**  
   長期運用する場合、Ubuntu Proを有効化してESM（Extended Security Maintenance）のパッケージを利用することで、LTSサポート終了後もセキュリティ更新を継続できます：

   ```bash
   sudo pro attach <your-token>
   ```

### 自動更新の頻度設定

`/etc/apt/apt.conf.d/20auto-upgrades` ファイルを編集し、以下を確認または設定します：

```plaintext
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
APT::Periodic::Download-Upgradeable-Packages "1";
```

- `APT::Periodic::Update-Package-Lists "1";`：毎日パッケージリストを更新。
- `APT::Periodic::Unattended-Upgrade "1";`：毎日自動アップグレードを実行。
- `APT::Periodic::AutocleanInterval "7";`：7日ごとに不要なパッケージを削除。
- `APT::Periodic::Download-Upgradeable-Packages "1";`：アップグレード可能なパッケージを事前にダウンロード。

#### アドバイス

1. **定期的なキャッシュクリーンアップ**  
   パッケージキャッシュの肥大化を防ぐため、`AutocleanInterval`の設定を確認し、適切な頻度（7～14日）で削除を行います。

2. **ダウンロードの事前実行**  
   `Download-Upgradeable-Packages` を有効にすることで、更新が利用可能になった際のダウンタイムを最小限に抑えられます。

### サービスの有効化

以下のコマンドを実行して、`unattended-upgrades` サービスを有効化および開始します：

```bash
sudo systemctl enable unattended-upgrades
sudo systemctl start unattended-upgrades
```

### ログの確認

更新状況を確認するには、`/var/log/unattended-upgrades/` ディレクトリ内のログファイルを参照します：

```bash
sudo less /var/log/unattended-upgrades/unattended-upgrades.log
```

### 例外パッケージの設定

特定のパッケージを自動更新から除外する場合、`/etc/apt/apt.conf.d/50unattended-upgrades` に以下を追加します：

```plaintext
Unattended-Upgrade::Package-Blacklist {
    "linux-image";
    "linux-headers";
};
```

この例では、`linux-image` や `linux-headers` のカーネル更新を除外します（カーネル更新は手動で行うことを推奨）。

### 自動再起動の設定

セキュリティ更新後に再起動が必要な場合、自動で再起動する設定を有効にします：

```plaintext
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "03:00";
```

- `Automatic-Reboot`：再起動の有無を設定。
- `Automatic-Reboot-Time`：再起動を行う時間（深夜帯推奨）。

## ディスクとログの定期清掃

サーバーのディスク容量が不足すると、システムの安定性に影響を与える可能性があります。そのため、定期的に不要なデータや古いログを削除する設定を行い、ディスクスペースを効率的に管理します。

### ログファイルの定期清掃

システムログを定期的に削除することで、ディスクの圧迫を防ぎます。

#### 手動でのログ清掃

以下のコマンドで、システムログを削除またはサイズ制限します。

  - **過去7日間のみ保持**：

    ```bash
    sudo journalctl --vacuum-time=7d
    ```

  - **ログのサイズを100MBに制限**：

    ```bash
    sudo journalctl --vacuum-size=100M
    ```

#### ログ清掃の自動化

`cron`を使用して定期的にログを清掃します。以下のコマンドを実行して`cron`の設定を編集します：

```bash
sudo crontab -e
```

以下の内容を追加します（毎日午前3時に実行）：

```plaintext
0 3 * * * /usr/bin/journalctl --vacuum-time=7d
```

### キャッシュと不要なパッケージの清掃

#### 手動でのキャッシュ清掃

以下のコマンドを使用して、キャッシュや不要なパッケージを削除します。

```bash
sudo apt autoremove -y
sudo apt autoclean -y
```

#### キャッシュ清掃の自動化

`cron`で自動化します。以下のコマンドを実行して設定を追加します：

```bash
sudo crontab -e
```

毎週日曜日の午前2時に実行する設定を追加します：

```plaintext
0 2 * * 7 /usr/bin/apt autoremove -y && /usr/bin/apt autoclean -y
```

### 一時ファイルの自動削除

`/tmp`ディレクトリ内の不要な一時ファイルを定期的に削除します。

#### `tmpreaper`のインストール

```bash
sudo apt install tmpreaper
```

#### 設定ファイルの編集

`/etc/tmpreaper.conf`を編集し、以下の設定を確認または追加します：

```plaintext
TMPREAPER_TIME="7d"
SHOWWARNING=false
```

- **TMPREAPER_TIME**：7日間以上アクセスのないファイルを削除。

#### 手動での一時ファイル削除

```bash
sudo tmpreaper 7d /tmp
```

#### 一時ファイル削除の自動化

`cron`を使用して毎日午前3時に実行します：

```plaintext
0 3 * * * /usr/sbin/tmpreaper 7d /tmp
```

### 自動清掃タスク一覧

以下は設定された自動清掃タスクの一覧です：

| タスク               | 周期          | コマンド                                      |
|----------------------|---------------|----------------------------------------------|
| システムログ清掃     | 毎日午前3時   | `/usr/bin/journalctl --vacuum-time=7d`       |
| 不要なパッケージ清掃 | 毎週日曜日2時 | `/usr/bin/apt autoremove -y && /usr/bin/apt autoclean -y` |
| ディスク使用状況通知 | 毎日午前8時   | `df -h | mail -s "Daily Disk Usage Report" your-email@example.com` |
| 一時ファイル削除     | 毎日午前3時   | `/usr/sbin/tmpreaper 7d /tmp`                |
