#!/usr/bin/env bash
set -euo pipefail
umask 077
install_root="$HOME/vibecliproxy"
mkdir -p "$install_root/.data/auths" "$install_root/bin" "$HOME/.config/systemd/user"
if [ ! -x "$install_root/bin/cli-proxy-api" ]; then
  download_dir="$(mktemp -d)"
  trap 'rm -rf -- "$download_dir"' EXIT
  archive='CLIProxyAPI_8.0.46_linux_amd64_no-plugin.tar.gz'
  release='https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.46'
  curl -fsSL "$release/$archive" -o "$download_dir/$archive"
  curl -fsSL "$release/checksums.txt" -o "$download_dir/checksums.txt"
  (cd "$download_dir" && awk -v name="$archive" '$2 == name || $2 == "*" name {print}' checksums.txt | sha256sum --check --status)
  tar -xzf "$download_dir/$archive" -C "$download_dir"
  install -m 700 "$download_dir/cli-proxy-api" "$install_root/bin/cli-proxy-api"
fi
VIBE_INSTALL_ROOT="$install_root" python3 - <<'PY'
import os,pathlib,json,secrets,subprocess
root=pathlib.Path(os.environ['VIBE_INSTALL_ROOT'])
env=root/'.env'
if not env.exists():
 status=json.loads(subprocess.check_output(['tailscale','status','--json']))
 dns=status['Self']['DNSName'].rstrip('.')
 keys={k:secrets.token_urlsafe(48) for k in ['CLIPROXY_API_KEY','CLIPROXY_MANAGEMENT_KEY']}
 values={'HOST':'127.0.0.1','PORT':'8320','PUBLIC_ORIGIN':f'https://{dns}','BASE_PATH':'/cliproxy','DATA_PATH':str(root/'.data/hub.db'),'ADMIN_PASSWORD_HASH':os.environ.get('ADMIN_PASSWORD_HASH',''),'CLIPROXY_URL':'http://127.0.0.1:8317',**keys}
 env.write_text(''.join(f'{k}={json.dumps(v)}\n' for k,v in values.items()));env.chmod(0o600)
 config={'host':'127.0.0.1','port':8317,'auth-dir':str(root/'.data/auths'),'api-keys':[keys['CLIPROXY_API_KEY']],'remote-management':{'allow-remote':False,'secret-key':keys['CLIPROXY_MANAGEMENT_KEY'],'disable-control-panel':True},'debug':False,'logging-to-file':False,'request-log':False,'usage-statistics-enabled':False,'force-model-prefix':True,'routing':{'strategy':'round-robin'},'quota-exceeded':{'switch-project':False,'switch-preview-model':False},'request-retry':0,'max-retry-credentials':1,'ws-auth':True}
 # JSON is valid YAML and avoids requiring a YAML library for setup.
 (root/'.data/cliproxy.yaml').write_text(json.dumps(config,indent=2)+'\n')
 (root/'.data/cliproxy.yaml').chmod(0o600)
print('Private service configuration is ready.')
PY
cat > "$HOME/.config/systemd/user/vibe-cliproxy.service" <<UNIT
[Unit]
Description=Vibe private CLIProxy account pool
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
WorkingDirectory=$install_root
ExecStart=$install_root/bin/cli-proxy-api --config $install_root/.data/cliproxy.yaml
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
[Install]
WantedBy=default.target
UNIT
cat > "$HOME/.config/systemd/user/vibe-hub.service" <<UNIT
[Unit]
Description=Vibe account sharing hub
After=network-online.target vibe-cliproxy.service
Wants=vibe-cliproxy.service
[Service]
Type=simple
WorkingDirectory=$install_root
EnvironmentFile=$install_root/.env
ExecStart=$HOME/.local/bin/node $install_root/dist/main.js
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now vibe-cliproxy.service
printf 'CLIProxy installed. Hub service prepared.\n'
